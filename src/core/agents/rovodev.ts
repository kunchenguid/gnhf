import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createWriteStream, readFileSync, type WriteStream } from "node:fs";
import { createServer } from "node:net";
import type {
  Agent,
  AgentOutput,
  AgentResult,
  AgentRunOptions,
  TokenUsage,
} from "./types.js";
import { appendDebugLog, serializeError } from "../debug-log.js";
import { shutdownChildProcess } from "./managed-process.js";

interface RovoDevRequestUsageEvent {
  input_tokens?: number;
  cache_write_tokens?: number;
  cache_read_tokens?: number;
  output_tokens?: number;
}

interface RovoDevSessionResponse {
  session_id: string;
}

interface RovoDevDeps {
  bin?: string;
  fetch?: typeof fetch;
  getPort?: () => Promise<number>;
  killProcess?: typeof process.kill;
  platform?: NodeJS.Platform;
  spawn?: typeof spawn;
}

interface RovoDevServer {
  baseUrl: string;
  child: ChildProcessWithoutNullStreams;
  cwd: string;
  detached: boolean;
  port: number;
  readyPromise: Promise<void>;
  closed: boolean;
  stdout: string;
  stderr: string;
}

function buildSystemPrompt(schema: string): string {
  return [
    "You are the coding agent used by gnhf.",
    "Work autonomously in the current workspace and use tools when needed.",
    "When you finish, reply with only valid JSON.",
    "Do not wrap the JSON in markdown fences.",
    "Do not include any prose before or after the JSON.",
    `The JSON must match this schema exactly: ${schema}`,
  ].join(" ");
}

function createAbortError(): Error {
  return new Error("Agent was aborted");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function shouldUseWindowsShell(
  bin: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform !== "win32") {
    return false;
  }

  if (/\.(cmd|bat)$/i.test(bin)) {
    return true;
  }

  if (/[\\/]/.test(bin)) {
    return false;
  }

  try {
    const resolved = execFileSync("where", [bin], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const firstMatch = resolved
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return firstMatch ? /\.(cmd|bat)$/i.test(firstMatch) : false;
  } catch {
    return false;
  }
}

function terminateRovoDevProcess(
  child: ReturnType<typeof spawn>,
  platform: NodeJS.Platform,
): void {
  if (platform === "win32" && child.pid) {
    try {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
        stdio: "ignore",
      });
    } catch {
      // Best-effort: the process may have already exited.
    }
    return;
  }

  child.kill("SIGTERM");
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
        reject(new Error("Failed to allocate a port for rovodev"));
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

export class RovoDevAgent implements Agent {
  name = "rovodev";

  private bin: string;
  private schemaPath: string;
  private fetchFn: typeof fetch;
  private getPortFn: () => Promise<number>;
  private killProcessFn: typeof process.kill;
  private platform: NodeJS.Platform;
  private spawnFn: typeof spawn;
  private server: RovoDevServer | null = null;
  private closingPromise: Promise<void> | null = null;

  constructor(schemaPath: string, deps: RovoDevDeps = {}) {
    this.bin = deps.bin ?? "acli";
    this.schemaPath = schemaPath;
    this.fetchFn = deps.fetch ?? fetch;
    this.getPortFn = deps.getPort ?? getAvailablePort;
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
    const runStartedAt = Date.now();

    appendDebugLog("rovodev:run:start", {
      cwd,
      promptLength: prompt.length,
      hasLogPath: logPath !== undefined,
    });

    const onAbort = () => {
      runController.abort();
    };

    if (signal?.aborted) {
      logStream?.end();
      appendDebugLog("rovodev:run:aborted-early", {});
      throw createAbortError();
    }

    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const server = await this.ensureServer(cwd, runController.signal);
      sessionId = await this.createSession(server, runController.signal);
      await this.setInlineSystemPrompt(server, sessionId, runController.signal);
      await this.setChatMessage(
        server,
        sessionId,
        prompt,
        runController.signal,
      );

      const result = await this.streamChat(
        server,
        sessionId,
        runController.signal,
        logStream,
        onUsage,
        onMessage,
      );
      appendDebugLog("rovodev:run:end", {
        sessionId,
        elapsedMs: Date.now() - runStartedAt,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });
      return result;
    } catch (error) {
      if (runController.signal.aborted || isAbortError(error)) {
        appendDebugLog("rovodev:run:aborted", {
          sessionId,
          elapsedMs: Date.now() - runStartedAt,
        });
        throw createAbortError();
      }
      appendDebugLog("rovodev:run:error", {
        sessionId,
        elapsedMs: Date.now() - runStartedAt,
        error: serializeError(error),
        serverStderr: this.server?.stderr.slice(-2048),
        serverStdout: this.server?.stdout.slice(-2048),
        serverClosed: this.server?.closed ?? true,
      });
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      logStream?.end();
      if (this.server && sessionId) {
        if (runController.signal.aborted) {
          await this.cancelSession(this.server, sessionId);
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
  ): Promise<RovoDevServer> {
    if (this.server && !this.server.closed && this.server.cwd === cwd) {
      await this.server.readyPromise;
      return this.server;
    }

    if (this.server && !this.server.closed) {
      await this.shutdownServer();
    }

    const port = await this.getPortFn();
    const detached = this.platform !== "win32";
    const child = this.spawnFn(
      this.bin,
      ["rovodev", "serve", "--disable-session-token", String(port)],
      {
        cwd,
        detached,
        shell: shouldUseWindowsShell(this.bin, this.platform),
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    ) as unknown as ChildProcessWithoutNullStreams;

    const server: RovoDevServer = {
      baseUrl: `http://127.0.0.1:${port}`,
      child,
      cwd,
      detached,
      port,
      readyPromise: Promise.resolve(),
      closed: false,
      stdout: "",
      stderr: "",
    };

    const MAX_OUTPUT = 64 * 1024;
    child.stdout.on("data", (data: Buffer) => {
      server.stdout += data.toString();
      if (server.stdout.length > MAX_OUTPUT) {
        server.stdout = server.stdout.slice(-MAX_OUTPUT);
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      server.stderr += data.toString();
      if (server.stderr.length > MAX_OUTPUT) {
        server.stderr = server.stderr.slice(-MAX_OUTPUT);
      }
    });

    child.on("close", (code, closeSignal) => {
      server.closed = true;
      appendDebugLog("rovodev:server:close", {
        cwd: server.cwd,
        port: server.port,
        code,
        signal: closeSignal,
        stderr: server.stderr.slice(-2048),
        stdout: server.stdout.slice(-2048),
      });
      if (this.server === server) {
        this.server = null;
      }
    });

    this.server = server;
    const spawnedAt = Date.now();
    appendDebugLog("rovodev:spawn", {
      cwd,
      port,
      detached,
      pid: child.pid,
      bin: this.bin,
    });
    server.readyPromise = this.waitForHealthy(server, signal)
      .then(() => {
        appendDebugLog("rovodev:server:ready", {
          port,
          elapsedMs: Date.now() - spawnedAt,
        });
      })
      .catch(async (error) => {
        appendDebugLog("rovodev:server:ready-failed", {
          port,
          elapsedMs: Date.now() - spawnedAt,
          error: serializeError(error),
          stderr: server.stderr.slice(-2048),
          stdout: server.stdout.slice(-2048),
        });
        await this.shutdownServer();
        throw error;
      });

    await server.readyPromise;
    return server;
  }

  private async waitForHealthy(
    server: RovoDevServer,
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
        throw new Error(`Failed to spawn rovodev: ${spawnErrorMessage}`);
      }

      if (server.closed) {
        const output = server.stderr.trim() || server.stdout.trim();
        throw new Error(
          output
            ? `rovodev exited before becoming ready: ${output}`
            : "rovodev exited before becoming ready",
        );
      }

      try {
        const response = await this.fetchFn(`${server.baseUrl}/healthcheck`, {
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
      `Timed out waiting for rovodev serve to become ready on port ${server.port}`,
    );
  }

  private async createSession(
    server: RovoDevServer,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.requestJSON<RovoDevSessionResponse>(
      server,
      "/v3/sessions/create",
      {
        method: "POST",
        body: { custom_title: "gnhf" },
        signal,
      },
    );
    appendDebugLog("rovodev:session:create", {
      sessionId: response.session_id,
    });
    return response.session_id;
  }

  private async setInlineSystemPrompt(
    server: RovoDevServer,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const schema = readFileSync(this.schemaPath, "utf-8").trim();
    await this.requestJSON(server, "/v3/inline-system-prompt", {
      method: "PUT",
      sessionId,
      body: { prompt: buildSystemPrompt(schema) },
      signal,
    });
  }

  private async setChatMessage(
    server: RovoDevServer,
    sessionId: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.requestJSON(server, "/v3/set_chat_message", {
      method: "POST",
      sessionId,
      body: { message: prompt },
      signal,
    });
  }

  private async cancelSession(
    server: RovoDevServer,
    sessionId: string,
  ): Promise<void> {
    try {
      await this.request(server, "/v3/cancel", {
        method: "POST",
        sessionId,
        timeoutMs: 1_000,
      });
      appendDebugLog("rovodev:session:cancel", { sessionId });
    } catch (error) {
      appendDebugLog("rovodev:session:cancel-failed", {
        sessionId,
        error: serializeError(error),
      });
      // Best effort only.
    }
  }

  private async deleteSession(
    server: RovoDevServer,
    sessionId: string,
  ): Promise<void> {
    try {
      await this.request(server, `/v3/sessions/${sessionId}`, {
        method: "DELETE",
        sessionId,
        timeoutMs: 1_000,
      });
      appendDebugLog("rovodev:session:delete", { sessionId });
    } catch (error) {
      appendDebugLog("rovodev:session:delete-failed", {
        sessionId,
        error: serializeError(error),
      });
      // Best effort only.
    }
  }

  private async streamChat(
    server: RovoDevServer,
    sessionId: string,
    signal: AbortSignal,
    logStream: WriteStream | null,
    onUsage?: (usage: TokenUsage) => void,
    onMessage?: (text: string) => void,
  ): Promise<AgentResult> {
    const streamStartedAt = Date.now();
    appendDebugLog("rovodev:stream:start", { sessionId });
    const response = await this.request(server, "/v3/stream_chat", {
      method: "GET",
      sessionId,
      headers: { accept: "text/event-stream" },
      signal,
    });

    if (!response.body) {
      appendDebugLog("rovodev:stream:no-body", { sessionId });
      throw new Error("rovodev returned no response body");
    }

    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    let latestTextSegment = "";
    let currentTextParts: string[] = [];
    let currentTextIndexes = new Map<number, number>();
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";

    const emitMessage = () => {
      const message = currentTextParts.join("").trim();
      if (message) {
        latestTextSegment = message;
        onMessage?.(message);
      }
    };

    const resetCurrentMessage = () => {
      currentTextParts = [];
      currentTextIndexes = new Map<number, number>();
    };

    const handleUsage = (event: RovoDevRequestUsageEvent) => {
      usage.inputTokens += event.input_tokens ?? 0;
      usage.outputTokens += event.output_tokens ?? 0;
      usage.cacheReadTokens += event.cache_read_tokens ?? 0;
      usage.cacheCreationTokens += event.cache_write_tokens ?? 0;
      onUsage?.({ ...usage });
    };

    const handleEvent = (rawEvent: string) => {
      const lines = rawEvent.split(/\r?\n/);
      let eventName = "";
      const dataLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventName = line.slice("event:".length).trim();
          continue;
        }

        if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trimStart());
        }
      }

      const rawData = dataLines.join("\n");
      if (rawData.length === 0) return;

      let payload: unknown;
      try {
        payload = JSON.parse(rawData);
      } catch {
        return;
      }

      const kind =
        eventName ||
        (typeof (payload as Record<string, unknown>).event_kind === "string"
          ? ((payload as Record<string, unknown>).event_kind as string)
          : "");

      if (kind === "request-usage") {
        handleUsage(payload as RovoDevRequestUsageEvent);
        return;
      }

      if (kind === "tool-return" || kind === "on_call_tools_start") {
        resetCurrentMessage();
        return;
      }

      if (kind === "text") {
        const content = (payload as { content?: unknown }).content;
        if (typeof content === "string") {
          currentTextParts = [content];
          currentTextIndexes = new Map<number, number>();
          emitMessage();
        }
        return;
      }

      if (kind === "part_start") {
        const partStart = payload as {
          index?: unknown;
          part?: { content?: unknown; part_kind?: unknown };
        };
        if (
          typeof partStart.index === "number" &&
          partStart.part?.part_kind === "text" &&
          typeof partStart.part.content === "string"
        ) {
          const nextIndex = currentTextParts.push(partStart.part.content) - 1;
          currentTextIndexes.set(partStart.index, nextIndex);
          emitMessage();
        }
        return;
      }

      if (kind === "part_delta") {
        const partDelta = payload as {
          index?: unknown;
          delta?: { content_delta?: unknown; part_delta_kind?: unknown };
        };
        if (
          typeof partDelta.index === "number" &&
          partDelta.delta?.part_delta_kind === "text" &&
          typeof partDelta.delta.content_delta === "string"
        ) {
          const textIndex = currentTextIndexes.get(partDelta.index);
          if (textIndex === undefined) {
            const nextIndex =
              currentTextParts.push(partDelta.delta.content_delta) - 1;
            currentTextIndexes.set(partDelta.index, nextIndex);
          } else {
            currentTextParts[textIndex] += partDelta.delta.content_delta;
          }
          emitMessage();
        }
      }
    };

    let bytesRead = 0;
    while (true) {
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await reader.read();
      } catch (error) {
        appendDebugLog("rovodev:stream:error", {
          sessionId,
          elapsedMs: Date.now() - streamStartedAt,
          bytesRead,
          error: serializeError(error),
          serverClosed: server.closed,
          serverStderr: server.stderr.slice(-2048),
        });
        if (isAbortError(error)) {
          throw createAbortError();
        }
        throw error;
      }

      if (readResult.done) break;

      const chunk = decoder.decode(readResult.value, { stream: true });
      logStream?.write(chunk);
      buffer += chunk;
      bytesRead += chunk.length;

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

        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + separatorLen);
        if (rawEvent.trim()) {
          handleEvent(rawEvent);
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      handleEvent(buffer);
    }

    appendDebugLog("rovodev:stream:end", {
      sessionId,
      elapsedMs: Date.now() - streamStartedAt,
      bytesRead,
    });

    const finalText = latestTextSegment.trim();
    if (!finalText) {
      appendDebugLog("rovodev:output:missing", { sessionId });
      throw new Error("rovodev returned no text output");
    }

    try {
      const output = JSON.parse(finalText) as AgentOutput;
      appendDebugLog("rovodev:output:parsed", {
        sessionId,
        outputTextLength: finalText.length,
      });
      return {
        output,
        usage,
      };
    } catch (error) {
      appendDebugLog("rovodev:output:parse-error", {
        sessionId,
        outputTextLength: finalText.length,
        outputTextSample: finalText.slice(0, 512),
        error: serializeError(error),
      });
      throw new Error(
        `Failed to parse rovodev output: ${error instanceof Error ? error.message : String(error)}`,
      );
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
    const shutdownStartedAt = Date.now();
    appendDebugLog("rovodev:shutdown", {
      cwd: server.cwd,
      port: server.port,
      pid: server.child.pid,
    });

    this.closingPromise =
      this.platform === "win32"
        ? new Promise<void>((resolve) => {
            const handleClose = () => {
              server.child.off("close", handleClose);
              resolve();
            };

            server.child.on("close", handleClose);

            try {
              terminateRovoDevProcess(server.child, this.platform);
            } catch {
              server.child.off("close", handleClose);
              resolve();
              return;
            }

            setTimeout(() => {
              server.child.off("close", handleClose);
              resolve();
            }, 100).unref?.();
          })
        : shutdownChildProcess(server.child, {
            detached: server.detached,
            killProcess: this.killProcessFn,
            timeoutMs: 3_000,
          });

    this.closingPromise = this.closingPromise.finally(() => {
      if (this.server === server) {
        this.server = null;
      }
      this.closingPromise = null;
      appendDebugLog("rovodev:shutdown:done", {
        port: server.port,
        elapsedMs: Date.now() - shutdownStartedAt,
      });
    });

    await this.closingPromise;
  }

  private async requestJSON<T>(
    server: RovoDevServer,
    path: string,
    options: RequestOptions,
  ): Promise<T> {
    const response = await this.request(server, path, options);
    return (await response.json()) as T;
  }

  private async request(
    server: RovoDevServer,
    path: string,
    options: RequestOptions,
  ): Promise<Response> {
    const headers = new Headers(options.headers);
    if (options.sessionId) {
      headers.set("x-session-id", options.sessionId);
    }
    if (options.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const signal = withTimeoutSignal(options.signal, options.timeoutMs);
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await this.fetchFn(`${server.baseUrl}${path}`, {
        method: options.method,
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        signal,
      });
    } catch (error) {
      appendDebugLog("rovodev:request:error", {
        method: options.method,
        path,
        elapsedMs: Date.now() - startedAt,
        timeoutMs: options.timeoutMs,
        error: serializeError(error),
        serverClosed: server.closed,
      });
      throw error;
    }

    if (!response.ok) {
      const body = await response.text();
      appendDebugLog("rovodev:request:non-ok", {
        method: options.method,
        path,
        status: response.status,
        elapsedMs: Date.now() - startedAt,
        bodySample: body.slice(0, 1024),
      });
      throw new Error(
        `rovodev ${options.method} ${path} failed with ${response.status}: ${body}`,
      );
    }

    return response;
  }
}

interface RequestOptions {
  method: "DELETE" | "GET" | "POST" | "PUT";
  headers?: HeadersInit;
  body?: unknown;
  sessionId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function withTimeoutSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (timeoutMs === undefined) return signal;

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}
