import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { createServer } from "node:net";
import {
  AGENT_OUTPUT_SCHEMA,
  type Agent,
  type AgentOutput,
  type AgentResult,
  type AgentRunOptions,
  type TokenUsage,
} from "./types.js";
import { appendDebugLog } from "../debug-log.js";
import { shutdownChildProcess } from "./managed-process.js";

interface ServeMessagePart {
  type?: string;
  text?: string;
  metadata?: {
    openai?: {
      phase?: string;
    };
  };
}

interface ServeTokens {
  input?: number;
  output?: number;
  cache?: {
    read?: number;
    write?: number;
  };
}

interface ServeMessageResponse {
  info?: {
    id?: string;
    role?: string;
    structured?: AgentOutput;
    tokens?: ServeTokens;
  };
  parts?: ServeMessagePart[];
}

interface ServeSessionResponse {
  id: string;
}

interface ServeStreamEvent {
  directory?: string;
  payload?: {
    type?: string;
    properties?: {
      sessionID?: string;
      field?: string;
      delta?: string;
      partID?: string;
      part?: {
        id?: string;
        messageID?: string;
        type?: string;
        text?: string;
        tokens?: ServeTokens;
        metadata?: {
          openai?: {
            phase?: string;
          };
        };
      };
      info?: {
        id?: string;
        role?: string;
        tokens?: ServeTokens;
      };
    };
  };
}

export interface ServeAgentDeps {
  bin?: string;
  fetch?: typeof fetch;
  getPort?: () => Promise<number>;
  killProcess?: typeof process.kill;
  platform?: NodeJS.Platform;
  spawn?: typeof spawn;
}

export interface ServeAgentServer {
  baseUrl: string;
  child: ChildProcessWithoutNullStreams;
  closed: boolean;
  cwd: string;
  detached: boolean;
  port: number;
  readyPromise: Promise<void>;
  stderr: string;
  stdout: string;
}

interface RequestOptions {
  method: "DELETE" | "GET" | "POST";
  body?: unknown;
  headers?: HeadersInit;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface ServeTextPartState {
  phase?: string;
  text: string;
}

type MessageRequestResult =
  | { ok: true; body: string }
  | { ok: false; error: unknown };

const BLANKET_PERMISSION_RULESET = [
  { permission: "*", pattern: "*", action: "allow" },
] as const;

const STRUCTURED_OUTPUT_FORMAT = {
  type: "json_schema",
  schema: AGENT_OUTPUT_SCHEMA,
  retryCount: 1,
} as const;

function buildServeChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.OPENCODE_SERVER_USERNAME;
  delete env.OPENCODE_SERVER_PASSWORD;
  return env;
}

function buildPrompt(prompt: string): string {
  return [
    prompt,
    "",
    "When you finish, reply with only valid JSON.",
    "Do not wrap the JSON in markdown fences.",
    "Do not include any prose before or after the JSON.",
    `The JSON must match this schema exactly: ${JSON.stringify(AGENT_OUTPUT_SCHEMA)}`,
  ].join("\n");
}

function findWindowsProcessListeningOnPort(port: number): number | null {
  try {
    const output = execFileSync("netstat", ["-ano", "-p", "tcp"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    });

    for (const line of output.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5 || parts[0] !== "TCP") continue;
      if (!parts[1]?.endsWith(`:${port}`)) continue;
      if (parts[3] !== "LISTENING") continue;

      const pid = Number.parseInt(parts[4] ?? "", 10);
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    }
  } catch {
    // Best-effort only.
  }

  return null;
}

function forceStopWindowsProcess(pid: number): void {
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`,
      ],
      {
        stdio: "ignore",
        timeout: 1_000,
      },
    );
  } catch {
    // Best-effort only.
  }
}

async function killWindowsProcessTree(pid: number, port: number): Promise<void> {
  try {
    execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
      stdio: "ignore",
      timeout: 1_000,
    });
    return;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : undefined;
    if (code !== "ETIMEDOUT") {
      return;
    }
  }

  const listeningPid = findWindowsProcessListeningOnPort(port);
  if (!listeningPid || listeningPid === pid) {
    return;
  }

  forceStopWindowsProcess(listeningPid);
}

function createAbortError(): Error {
  return new Error("Agent was aborted");
}

function isAgentAbortError(error: unknown): boolean {
  return error instanceof Error && error.message === "Agent was aborted";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function getAvailablePort(label: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error(`Failed to allocate a port for ${label}`));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function toUsage(tokens?: ServeTokens): TokenUsage {
  return {
    inputTokens: tokens?.input ?? 0,
    outputTokens: tokens?.output ?? 0,
    cacheReadTokens: tokens?.cache?.read ?? 0,
    cacheCreationTokens: tokens?.cache?.write ?? 0,
  };
}

function withTimeoutSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (timeoutMs === undefined) return signal;

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export class ServeBasedAgent implements Agent {
  name: string;

  protected bin: string;
  protected fetchFn: typeof fetch;
  protected getPortFn: () => Promise<number>;
  protected killProcessFn: typeof process.kill;
  protected platform: NodeJS.Platform;
  protected spawnFn: typeof spawn;
  protected server: ServeAgentServer | null = null;
  protected closingPromise: Promise<void> | null = null;

  protected get debugLogPrefix(): string {
    return this.name;
  }

  protected get portLabel(): string {
    return this.name;
  }

  protected get spawnErrorMessage(): string {
    return `Failed to spawn ${this.name}`;
  }

  protected get exitedErrorMessage(): string {
    return `${this.name} exited before becoming ready`;
  }

  protected get noStreamBodyError(): string {
    return `${this.name} returned no event stream body`;
  }

  protected get noTextOutputError(): string {
    return `${this.name} returned no text output`;
  }

  protected get parseResponseError(): string {
    return `Failed to parse ${this.name} response`;
  }

  protected get parseOutputError(): string {
    return `Failed to parse ${this.name} output`;
  }

  protected get requestErrorPrefix(): string {
    return this.name;
  }

  constructor(deps: ServeAgentDeps & { name?: string } = {}) {
    this.name = deps.name ?? "serve-agent";
    this.bin = deps.bin ?? this.name;
    this.fetchFn = deps.fetch ?? fetch;
    this.getPortFn = deps.getPort ?? (() => getAvailablePort(this.portLabel));
    this.killProcessFn = deps.killProcess ?? process.kill.bind(process);
    this.platform = deps.platform ?? process.platform;
    this.spawnFn = deps.spawn ?? spawn;
  }

  async run(
    prompt: string,
    cwd: string,
    options?: AgentRunOptions,
  ): Promise<AgentResult> {
    const { onUsage, onMessage, signal, logPath } = options ?? {};
    const logStream = logPath ? createWriteStream(logPath) : null;
    const runController = new AbortController();
    let sessionId: string | null = null;

    const onAbort = () => {
      runController.abort();
    };

    if (signal?.aborted) {
      logStream?.end();
      throw createAbortError();
    }

    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const server = await this.ensureServer(cwd, runController.signal);
      sessionId = await this.createSession(server, cwd, runController.signal);
      return await this.streamMessage(
        server,
        sessionId,
        buildPrompt(prompt),
        runController.signal,
        logStream,
        onUsage,
        onMessage,
      );
    } catch (error) {
      if (runController.signal.aborted || isAbortError(error)) {
        throw createAbortError();
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      logStream?.end();
      if (this.server && sessionId) {
        if (runController.signal.aborted) {
          await this.abortSession(this.server, sessionId);
        }
        await this.deleteSession(this.server, sessionId);
      }
    }
  }

  async close(): Promise<void> {
    await this.shutdownServer();
  }

  protected async ensureServer(
    cwd: string,
    signal?: AbortSignal,
  ): Promise<ServeAgentServer> {
    if (this.server && !this.server.closed) {
      if (this.server.cwd !== cwd) {
        await this.shutdownServer();
      } else {
        await this.server.readyPromise;
        return this.server;
      }
    }

    const port = await this.getPortFn();
    const isWindows = this.platform === "win32";
    const detached = !isWindows;
    const child = this.spawnFn(
      this.bin,
      [
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
        "--print-logs",
      ],
      {
        cwd,
        detached,
        shell: isWindows,
        stdio: ["ignore", "pipe", "pipe"],
        env: buildServeChildEnv(),
      },
    ) as unknown as ChildProcessWithoutNullStreams;

    const server: ServeAgentServer = {
      baseUrl: `http://127.0.0.1:${port}`,
      child,
      closed: false,
      cwd,
      detached,
      port,
      readyPromise: Promise.resolve(),
      stderr: "",
      stdout: "",
    };

    const maxOutput = 64 * 1024;
    child.stdout.on("data", (data: Buffer) => {
      server.stdout += data.toString();
      if (server.stdout.length > maxOutput) {
        server.stdout = server.stdout.slice(-maxOutput);
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      server.stderr += data.toString();
      if (server.stderr.length > maxOutput) {
        server.stderr = server.stderr.slice(-maxOutput);
      }
    });

    child.on("close", () => {
      server.closed = true;
      if (this.server === server) {
        this.server = null;
      }
    });

    this.server = server;
    appendDebugLog(`${this.debugLogPrefix}:spawn`, { cwd, port, detached });
    server.readyPromise = this.waitForHealthy(server, signal).catch(
      async (error) => {
        await this.shutdownServer();
        throw error;
      },
    );

    await server.readyPromise;
    return server;
  }

  protected async waitForHealthy(
    server: ServeAgentServer,
    signal?: AbortSignal,
  ): Promise<void> {
    const timeoutController = new AbortController();
    const timeoutTimer = setTimeout(() => {
      timeoutController.abort();
    }, 30_000);
    const combined = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;
    let spawnErr: string | null = null;

    server.child.once("error", (error) => {
      spawnErr = error.message;
    });

    const poll = async (): Promise<void> => {
      while (!combined.aborted) {
        if (spawnErr) {
          throw new Error(`${this.spawnErrorMessage}: ${spawnErr}`);
        }

        if (server.closed) {
          const output = server.stderr.trim() || server.stdout.trim();
          throw new Error(
            output
              ? `${this.exitedErrorMessage}: ${output}`
              : this.exitedErrorMessage,
          );
        }

        try {
          const response = await this.fetchFn(
            `${server.baseUrl}/global/health`,
            {
              method: "GET",
              signal: combined,
            },
          );
          if (response.ok) {
            clearTimeout(timeoutTimer);
            return;
          }
        } catch (error) {
          if (isAbortError(error)) {
            throw createAbortError();
          }
        }

        await delay(250, combined);
      }

      clearTimeout(timeoutTimer);
      throw createAbortError();
    };

    await poll();
  }

  protected async createSession(
    server: ServeAgentServer,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.requestJSON<ServeSessionResponse>(
      server,
      "/session",
      {
        method: "POST",
        body: {
          directory: cwd,
          permission: BLANKET_PERMISSION_RULESET,
        },
        signal,
      },
    );

    return response.id;
  }

  protected async streamMessage(
    server: ServeAgentServer,
    sessionId: string,
    prompt: string,
    signal: AbortSignal,
    logStream: WriteStream | null,
    onUsage?: (usage: TokenUsage) => void,
    onMessage?: (text: string) => void,
  ): Promise<AgentResult> {
    const streamAbortController = new AbortController();
    const streamSignal = AbortSignal.any([
      signal,
      streamAbortController.signal,
    ]);
    const eventResponse = await this.request(server, "/global/event", {
      method: "GET",
      headers: { accept: "text/event-stream" },
      signal: streamSignal,
    });

    if (!eventResponse.body) {
      throw new Error(this.noStreamBodyError);
    }

    let messageRequestError: unknown = null;
    const messageRequest = (async (): Promise<MessageRequestResult> => {
      try {
        const body = await this.requestText(
          server,
          `/session/${sessionId}/message`,
          {
            method: "POST",
            body: {
              role: "user",
              parts: [{ type: "text", text: prompt }],
              format: STRUCTURED_OUTPUT_FORMAT,
            },
            signal,
          },
        );
        return { ok: true, body };
      } catch (error) {
        messageRequestError = error;
        streamAbortController.abort();
        return { ok: false, error };
      }
    })();

    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    const prevUsageByMessageId = new Map<string, TokenUsage>();
    const textParts = new Map<string, ServeTextPartState>();
    let lastText: string | null = null;
    let lastFinalAnswerText: string | null = null;

    const updateUsage = (
      messageId: string | undefined,
      tokens?: ServeTokens,
    ) => {
      if (!messageId || !tokens) return;
      const prev = prevUsageByMessageId.get(messageId) ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };
      const next = toUsage(tokens);
      const dInput = next.inputTokens - prev.inputTokens;
      const dOutput = next.outputTokens - prev.outputTokens;
      const dCacheRead = next.cacheReadTokens - prev.cacheReadTokens;
      const dCacheWrite = next.cacheCreationTokens - prev.cacheCreationTokens;
      if (
        dInput === 0 &&
        dOutput === 0 &&
        dCacheRead === 0 &&
        dCacheWrite === 0
      ) {
        prevUsageByMessageId.set(messageId, next);
        return;
      }
      usage.inputTokens += dInput;
      usage.outputTokens += dOutput;
      usage.cacheReadTokens += dCacheRead;
      usage.cacheCreationTokens += dCacheWrite;
      prevUsageByMessageId.set(messageId, next);
      onUsage?.({ ...usage });
    };

    const emitText = (partId: string, nextText: string, phase?: string) => {
      const trimmed = nextText.trim();
      textParts.set(partId, { text: nextText, phase });
      if (!trimmed) return;
      lastText = nextText;
      if (phase === "final_answer") {
        lastFinalAnswerText = nextText;
      }
      onMessage?.(trimmed);
    };

    const handleEvent = (event: ServeStreamEvent) => {
      const payload = event.payload;
      const properties = payload?.properties;
      if (!properties || properties.sessionID !== sessionId) return false;

      if (
        payload?.type === "message.part.delta" &&
        properties.field === "text" &&
        typeof properties.partID === "string" &&
        typeof properties.delta === "string"
      ) {
        const current = textParts.get(properties.partID);
        emitText(
          properties.partID,
          `${current?.text ?? ""}${properties.delta}`,
          current?.phase,
        );
        return false;
      }

      if (payload?.type === "message.part.updated") {
        const part = properties.part;
        if (!part) return false;

        if (part.type === "text" && typeof part.id === "string") {
          emitText(part.id, part.text ?? "", part.metadata?.openai?.phase);
          return false;
        }

        if (part.type === "step-finish") {
          updateUsage(part.messageID, part.tokens);
          return false;
        }

        return false;
      }

      if (payload?.type === "message.updated") {
        if (properties.info?.role === "assistant") {
          updateUsage(properties.info.id, properties.info.tokens);
        }
        return false;
      }

      return payload?.type === "session.idle";
    };

    const decoder = new TextDecoder();
    const reader = eventResponse.body.getReader();
    let buffer = "";
    let sawSessionIdle = false;

    const processRawEvent = (rawEvent: string) => {
      if (!rawEvent.trim()) return;

      let dataContent = "";
      for (const line of rawEvent.split(/\r?\n/)) {
        if (line.startsWith("data:")) {
          const content = line.slice(5).trimStart();
          if (dataContent) dataContent += "\n";
          dataContent += content;
        }
      }
      if (!dataContent) return;

      try {
        const event = JSON.parse(dataContent) as ServeStreamEvent;
        if (handleEvent(event)) {
          sawSessionIdle = true;
        }
      } catch {
        // Ignore malformed SSE events.
      }
    };

    const processBufferedEvents = (flushRemainder = false) => {
      while (true) {
        const lfBoundary = buffer.indexOf("\n\n");
        const crlfBoundary = buffer.indexOf("\r\n\r\n");
        let boundary: number;
        let separatorLen: number;

        if (lfBoundary === -1 && crlfBoundary === -1) break;
        if (
          crlfBoundary !== -1 &&
          (lfBoundary === -1 || crlfBoundary < lfBoundary)
        ) {
          boundary = crlfBoundary;
          separatorLen = 4;
        } else {
          boundary = lfBoundary;
          separatorLen = 2;
        }

        processRawEvent(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + separatorLen);
        if (sawSessionIdle) return;
      }

      if (flushRemainder && buffer.trim()) {
        processRawEvent(buffer);
        buffer = "";
      }
    };

    try {
      while (!sawSessionIdle) {
        let readResult: ReadableStreamReadResult<Uint8Array>;
        try {
          readResult = await reader.read();
        } catch (error) {
          if (messageRequestError) {
            if (
              isAbortError(messageRequestError) ||
              isAgentAbortError(messageRequestError)
            ) {
              throw createAbortError();
            }
            throw messageRequestError;
          }
          if (isAbortError(error)) {
            throw createAbortError();
          }
          throw error;
        }

        if (readResult.done) {
          const tail = decoder.decode();
          if (tail) {
            logStream?.write(tail);
            buffer += tail;
          }
          processBufferedEvents(true);
          break;
        }

        const chunk = decoder.decode(readResult.value, { stream: true });
        logStream?.write(chunk);
        buffer += chunk;
        processBufferedEvents();
      }
    } finally {
      streamAbortController.abort();
      await reader.cancel().catch(() => undefined);
      textParts.clear();
    }

    const messageResult = await messageRequest;
    if (!messageResult.ok) {
      if (
        isAbortError(messageResult.error) ||
        isAgentAbortError(messageResult.error)
      ) {
        throw createAbortError();
      }
      throw messageResult.error;
    }

    const body = messageResult.body;
    let response: ServeMessageResponse;
    try {
      response = JSON.parse(body) as ServeMessageResponse;
    } catch (error) {
      throw new Error(
        `${this.parseResponseError}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (response.info?.role === "assistant") {
      updateUsage(response.info.id, response.info.tokens);
    }

    for (const part of response.parts ?? []) {
      if (part.type !== "text" || typeof part.text !== "string") continue;
      if (!part.text.trim()) continue;
      lastText = part.text;
      if (part.metadata?.openai?.phase === "final_answer") {
        lastFinalAnswerText = part.text;
      }
    }

    prevUsageByMessageId.clear();

    if (response.info?.structured) {
      return {
        output: response.info.structured,
        usage,
      };
    }

    const outputText = lastFinalAnswerText ?? lastText;
    if (!outputText) {
      throw new Error(this.noTextOutputError);
    }

    try {
      return {
        output: JSON.parse(outputText) as AgentOutput,
        usage,
      };
    } catch (error) {
      throw new Error(
        `${this.parseOutputError}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  protected async deleteSession(
    server: ServeAgentServer,
    sessionId: string,
  ): Promise<void> {
    try {
      await this.request(server, `/session/${sessionId}`, {
        method: "DELETE",
        timeoutMs: 1_000,
      });
    } catch {
      // Best effort only.
    }
  }

  protected async abortSession(
    server: ServeAgentServer,
    sessionId: string,
  ): Promise<void> {
    try {
      await this.request(server, `/session/${sessionId}/abort`, {
        method: "POST",
        timeoutMs: 1_000,
      });
    } catch {
      // Best effort only.
    }
  }

  protected async shutdownServer(): Promise<void> {
    if (!this.server || this.server.closed) {
      this.server = null;
      return;
    }

    if (this.closingPromise) {
      await this.closingPromise;
      return;
    }

    const server = this.server;
    appendDebugLog(`${this.debugLogPrefix}:shutdown`, {
      cwd: server.cwd,
      port: server.port,
    });

    this.closingPromise = (
      this.platform === "win32" && server.child.pid
        ? killWindowsProcessTree(server.child.pid, server.port)
        : shutdownChildProcess(server.child, {
            detached: server.detached,
            killProcess: this.killProcessFn,
            timeoutMs: 3_000,
          })
    ).finally(() => {
      if (this.server === server) {
        this.server = null;
      }
      this.closingPromise = null;
    });

    await this.closingPromise;
  }

  protected async requestJSON<T>(
    server: ServeAgentServer,
    path: string,
    options: RequestOptions,
  ): Promise<T> {
    const body = await this.requestText(server, path, options);
    return JSON.parse(body) as T;
  }

  protected async requestText(
    server: ServeAgentServer,
    path: string,
    options: RequestOptions,
  ): Promise<string> {
    const response = await this.request(server, path, options);
    return await response.text();
  }

  protected async request(
    server: ServeAgentServer,
    path: string,
    options: RequestOptions,
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (options.headers) {
      const h = options.headers;
      if (h instanceof Headers) {
        for (const [k, v] of h.entries()) {
          headers[k] = v;
        }
      } else {
        for (const [k, v] of Object.entries(h as Record<string, string>)) {
          headers[k] = v;
        }
      }
    }

    const signal = withTimeoutSignal(options.signal, options.timeoutMs);
    const response = await this.fetchFn(`${server.baseUrl}${path}`, {
      method: options.method,
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal,
    });

    if (!response.ok) {
      let body = "";
      try {
        body = await response.text();
      } catch {
        body = "[could not read body]";
      }
      throw new Error(
        `${this.requestErrorPrefix} ${options.method} ${path} failed with ${response.status}: ${body}`,
      );
    }

    return response;
  }
}

export class OpenCodeAgent extends ServeBasedAgent {
  name = "opencode";

  constructor(deps: ServeAgentDeps = {}) {
    super({ ...deps, name: "opencode" });
  }
}
