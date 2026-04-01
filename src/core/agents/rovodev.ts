import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, readFileSync, type WriteStream } from "node:fs";
import { createServer } from "node:net";
import type {
  Agent,
  AgentOutput,
  AgentResult,
  AgentRunOptions,
  TokenUsage,
} from "./types.js";

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
  fetch?: typeof fetch;
  getPort?: () => Promise<number>;
  killProcess?: typeof process.kill;
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

  private schemaPath: string;
  private fetchFn: typeof fetch;
  private getPortFn: () => Promise<number>;
  private killProcessFn: typeof process.kill;
  private spawnFn: typeof spawn;
  private server: RovoDevServer | null = null;
  private closingPromise: Promise<void> | null = null;

  constructor(schemaPath: string, deps: RovoDevDeps = {}) {
    this.schemaPath = schemaPath;
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
      sessionId = await this.createSession(server, runController.signal);
      await this.setInlineSystemPrompt(server, sessionId, runController.signal);
      await this.setChatMessage(
        server,
        sessionId,
        prompt,
        runController.signal,
      );

      return await this.streamChat(
        server,
        sessionId,
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
    const detached = process.platform !== "win32";
    const child = this.spawnFn(
      "acli",
      ["rovodev", "serve", "--disable-session-token", String(port)],
      {
        cwd,
        detached,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );

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
    server: RovoDevServer,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + 30_000;
    let spawnError: Error | null = null;

    server.child.once("error", (error) => {
      spawnError = error;
    });

    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw createAbortError();
      }

      if (spawnError) {
        throw new Error(`Failed to spawn rovodev: ${spawnError.message}`);
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
    } catch {
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
    } catch {
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
    const response = await this.request(server, "/v3/stream_chat", {
      method: "GET",
      sessionId,
      headers: { accept: "text/event-stream" },
      signal,
    });

    if (!response.body) {
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

    while (true) {
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await reader.read();
      } catch (error) {
        if (isAbortError(error)) {
          throw createAbortError();
        }
        throw error;
      }

      if (readResult.done) break;

      const chunk = decoder.decode(readResult.value, { stream: true });
      logStream?.write(chunk);
      buffer += chunk;

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

    const finalText = latestTextSegment.trim();
    if (!finalText) {
      throw new Error("rovodev returned no text output");
    }

    try {
      return {
        output: JSON.parse(finalText) as AgentOutput,
        usage,
      };
    } catch (error) {
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

  private signalServer(server: RovoDevServer, signal: NodeJS.Signals): void {
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
