import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

interface OpenCodeMessagePart {
  type?: string;
  text?: string;
  metadata?: {
    openai?: {
      phase?: string;
    };
  };
}

interface OpenCodeTokens {
  input?: number;
  output?: number;
  cache?: {
    read?: number;
    write?: number;
  };
}

interface OpenCodeMessageResponse {
  info?: {
    id?: string;
    role?: string;
    structured?: AgentOutput;
    tokens?: OpenCodeTokens;
  };
  parts?: OpenCodeMessagePart[];
}

interface OpenCodeSessionResponse {
  id: string;
}

interface OpenCodeStreamEvent {
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
        tokens?: OpenCodeTokens;
        metadata?: {
          openai?: {
            phase?: string;
          };
        };
      };
      info?: {
        id?: string;
        role?: string;
        tokens?: OpenCodeTokens;
      };
    };
  };
}

interface OpenCodeDeps {
  fetch?: typeof fetch;
  getPort?: () => Promise<number>;
  killProcess?: typeof process.kill;
  spawn?: typeof spawn;
}

interface OpenCodeServer {
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

interface OpenCodeTextPartState {
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

function buildOpencodeChildEnv(): NodeJS.ProcessEnv {
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

function createAbortError(): Error {
  return new Error("Agent was aborted");
}

function isAgentAbortError(error: unknown): boolean {
  return error instanceof Error && error.message === "Agent was aborted";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a port for opencode"));
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

function toUsage(tokens?: OpenCodeTokens): TokenUsage {
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

export class OpenCodeAgent implements Agent {
  name = "opencode";

  private fetchFn: typeof fetch;
  private getPortFn: () => Promise<number>;
  private killProcessFn: typeof process.kill;
  private spawnFn: typeof spawn;
  private server: OpenCodeServer | null = null;
  private closingPromise: Promise<void> | null = null;

  constructor(deps: OpenCodeDeps = {}) {
    this.fetchFn = deps.fetch ?? fetch;
    this.getPortFn = deps.getPort ?? getAvailablePort;
    this.killProcessFn = deps.killProcess ?? process.kill.bind(process);
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

  private async ensureServer(
    cwd: string,
    signal?: AbortSignal,
  ): Promise<OpenCodeServer> {
    if (this.server && !this.server.closed) {
      if (this.server.cwd !== cwd) {
        await this.shutdownServer();
      } else {
        await this.server.readyPromise;
        return this.server;
      }
    }

    if (this.server && !this.server.closed) {
      await this.server.readyPromise;
      return this.server;
    }

    const port = await this.getPortFn();
    const detached = process.platform !== "win32";
    const child = this.spawnFn(
      "opencode",
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
        stdio: ["ignore", "pipe", "pipe"],
        env: buildOpencodeChildEnv(),
      },
    ) as unknown as ChildProcessWithoutNullStreams;

    const server: OpenCodeServer = {
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
    server.readyPromise = this.waitForHealthy(server, signal).catch(
      async (error) => {
        await this.shutdownServer();
        throw error;
      },
    );

    await server.readyPromise;
    return server;
  }

  private async waitForHealthy(
    server: OpenCodeServer,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + 30_000;
    let spawnErrorMessage: string | null = null;

    server.child.once("error", (error) => {
      spawnErrorMessage = error.message;
    });

    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw createAbortError();
      }

      if (spawnErrorMessage) {
        throw new Error(`Failed to spawn opencode: ${spawnErrorMessage}`);
      }

      if (server.closed) {
        const output = server.stderr.trim() || server.stdout.trim();
        throw new Error(
          output
            ? `opencode exited before becoming ready: ${output}`
            : "opencode exited before becoming ready",
        );
      }

      try {
        const response = await this.fetchFn(`${server.baseUrl}/global/health`, {
          method: "GET",
          signal,
        });
        if (response.ok) return;
      } catch (error) {
        if (isAbortError(error)) {
          throw createAbortError();
        }
      }

      await delay(250, signal);
    }

    throw new Error(
      `Timed out waiting for opencode serve to become ready on port ${server.port}`,
    );
  }

  private async createSession(
    server: OpenCodeServer,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.requestJSON<OpenCodeSessionResponse>(
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

  private async streamMessage(
    server: OpenCodeServer,
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
      throw new Error("opencode returned no event stream body");
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
    const usageByMessageId = new Map<string, TokenUsage>();
    const textParts = new Map<string, OpenCodeTextPartState>();
    let lastText: string | null = null;
    let lastFinalAnswerText: string | null = null;
    let lastUsageSignature = "0:0:0:0";

    const updateUsage = (
      messageId: string | undefined,
      tokens?: OpenCodeTokens,
    ) => {
      if (!messageId || !tokens) return;
      usageByMessageId.set(messageId, toUsage(tokens));

      let nextInputTokens = 0;
      let nextOutputTokens = 0;
      let nextCacheReadTokens = 0;
      let nextCacheCreationTokens = 0;
      for (const messageUsage of usageByMessageId.values()) {
        nextInputTokens += messageUsage.inputTokens;
        nextOutputTokens += messageUsage.outputTokens;
        nextCacheReadTokens += messageUsage.cacheReadTokens;
        nextCacheCreationTokens += messageUsage.cacheCreationTokens;
      }

      const signature = [
        nextInputTokens,
        nextOutputTokens,
        nextCacheReadTokens,
        nextCacheCreationTokens,
      ].join(":");
      usage.inputTokens = nextInputTokens;
      usage.outputTokens = nextOutputTokens;
      usage.cacheReadTokens = nextCacheReadTokens;
      usage.cacheCreationTokens = nextCacheCreationTokens;
      if (signature !== lastUsageSignature) {
        lastUsageSignature = signature;
        onUsage?.({ ...usage });
      }
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

    const handleEvent = (event: OpenCodeStreamEvent) => {
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

      const dataLines = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart());
      if (dataLines.length === 0) return;

      try {
        const event = JSON.parse(dataLines.join("\n")) as OpenCodeStreamEvent;
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
    let response: OpenCodeMessageResponse;
    try {
      response = JSON.parse(body) as OpenCodeMessageResponse;
    } catch (error) {
      throw new Error(
        `Failed to parse opencode response: ${error instanceof Error ? error.message : String(error)}`,
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

    if (response.info?.structured) {
      return {
        output: response.info.structured,
        usage,
      };
    }

    const outputText = lastFinalAnswerText ?? lastText;
    if (!outputText) {
      throw new Error("opencode returned no text output");
    }

    try {
      return {
        output: JSON.parse(outputText) as AgentOutput,
        usage,
      };
    } catch (error) {
      throw new Error(
        `Failed to parse opencode output: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async deleteSession(
    server: OpenCodeServer,
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

  private async abortSession(
    server: OpenCodeServer,
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

  private async shutdownServer(): Promise<void> {
    if (!this.server || this.server.closed) {
      this.server = null;
      return;
    }

    if (this.closingPromise) {
      await this.closingPromise;
      return;
    }

    const server = this.server;
    const waitForClose = new Promise<void>((resolve) => {
      if (server.closed) {
        resolve();
        return;
      }
      server.child.once("close", () => resolve());
    });

    try {
      this.signalServer(server, "SIGTERM");
    } catch {
      // Best effort only.
    }

    const forceKill = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!server.closed) {
          try {
            this.signalServer(server, "SIGKILL");
          } catch {
            // Best effort only.
          }
        }
        resolve();
      }, 3_000);
      timer.unref?.();
    });

    this.closingPromise = Promise.race([waitForClose, forceKill]).finally(
      () => {
        if (this.server === server) {
          this.server = null;
        }
        this.closingPromise = null;
      },
    );

    await this.closingPromise;
  }

  private signalServer(server: OpenCodeServer, signal: NodeJS.Signals): void {
    if (server.detached && server.child.pid) {
      try {
        this.killProcessFn(-server.child.pid, signal);
        return;
      } catch {
        // Fall back to killing the direct child below.
      }
    }

    server.child.kill(signal);
  }

  private async requestJSON<T>(
    server: OpenCodeServer,
    path: string,
    options: RequestOptions,
  ): Promise<T> {
    const body = await this.requestText(server, path, options);
    return JSON.parse(body) as T;
  }

  private async requestText(
    server: OpenCodeServer,
    path: string,
    options: RequestOptions,
  ): Promise<string> {
    const response = await this.request(server, path, options);
    return await response.text();
  }

  private async request(
    server: OpenCodeServer,
    path: string,
    options: RequestOptions,
  ): Promise<Response> {
    const headers = new Headers(options.headers);
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
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
      const body = await response.text();
      throw new Error(
        `opencode ${options.method} ${path} failed with ${response.status}: ${body}`,
      );
    }

    return response;
  }
}
