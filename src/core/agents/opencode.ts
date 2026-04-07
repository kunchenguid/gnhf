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
import { appendDebugLog, serializeError } from "../debug-log.js";
import { shutdownChildProcess } from "./managed-process.js";

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
  bin?: string;
  fetch?: typeof fetch;
  getPort?: () => Promise<number>;
  killProcess?: typeof process.kill;
  platform?: NodeJS.Platform;
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

interface StreamTelemetry {
  eventCounts: Record<string, number>;
  firstEventAtMs: number | null;
  lastEventAtMs: number | null;
  lastHeartbeatAtMs: number | null;
  msSinceLastEvent: number | null;
  phaseTransitions: Array<{ phase: string; atMs: number }>;
  currentPhase: string | null;
  sawSessionIdle: boolean;
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

/**
 * On Windows with `shell: true`, `child.pid` is the `cmd.exe` wrapper, not
 * the actual server process.  `taskkill /T` terminates the entire process
 * tree rooted at that PID so the real server doesn't survive shutdown.
 */
async function killWindowsProcessTree(pid: number): Promise<void> {
  try {
    execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
      stdio: "ignore",
    });
  } catch {
    // Best-effort: the process may have already exited.
  }
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

  private bin: string;
  private fetchFn: typeof fetch;
  private getPortFn: () => Promise<number>;
  private killProcessFn: typeof process.kill;
  private platform: NodeJS.Platform;
  private spawnFn: typeof spawn;
  private server: OpenCodeServer | null = null;
  private closingPromise: Promise<void> | null = null;

  constructor(deps: OpenCodeDeps = {}) {
    this.bin = deps.bin ?? "opencode";
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

    appendDebugLog("opencode:run:start", {
      cwd,
      promptLength: prompt.length,
      hasLogPath: logPath !== undefined,
    });

    const onAbort = () => {
      runController.abort();
    };

    if (signal?.aborted) {
      logStream?.end();
      appendDebugLog("opencode:run:aborted-early", {});
      throw createAbortError();
    }

    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const server = await this.ensureServer(cwd, runController.signal);
      sessionId = await this.createSession(server, cwd, runController.signal);
      const result = await this.streamMessage(
        server,
        sessionId,
        buildPrompt(prompt),
        runController.signal,
        logStream,
        onUsage,
        onMessage,
      );
      appendDebugLog("opencode:run:end", {
        sessionId,
        elapsedMs: Date.now() - runStartedAt,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });
      return result;
    } catch (error) {
      if (runController.signal.aborted || isAbortError(error)) {
        appendDebugLog("opencode:run:aborted", {
          sessionId,
          elapsedMs: Date.now() - runStartedAt,
        });
        throw createAbortError();
      }
      appendDebugLog("opencode:run:error", {
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
    const maxMirroredLineLength = 2048;
    const maxMirroredLinesPerRun = 500;
    let mirroredLineCount = 0;
    let mirroredSuppressionLogged = false;
    const stderrLineBuffer = { tail: "" };

    const mirrorStderrChunk = (chunk: string) => {
      stderrLineBuffer.tail += chunk;
      let newlineIndex = stderrLineBuffer.tail.indexOf("\n");
      while (newlineIndex !== -1) {
        const rawLine = stderrLineBuffer.tail.slice(0, newlineIndex);
        stderrLineBuffer.tail = stderrLineBuffer.tail.slice(newlineIndex + 1);
        const line = rawLine.replace(/\r$/, "");
        if (line.length > 0) {
          if (mirroredLineCount >= maxMirroredLinesPerRun) {
            if (!mirroredSuppressionLogged) {
              appendDebugLog("opencode:server:stderr:suppressed", {
                port: server.port,
                cap: maxMirroredLinesPerRun,
              });
              mirroredSuppressionLogged = true;
            }
          } else {
            mirroredLineCount += 1;
            appendDebugLog("opencode:server:stderr", {
              port: server.port,
              line:
                line.length > maxMirroredLineLength
                  ? `${line.slice(0, maxMirroredLineLength)}…`
                  : line,
              truncated: line.length > maxMirroredLineLength,
            });
          }
        }
        newlineIndex = stderrLineBuffer.tail.indexOf("\n");
      }
    };

    child.stdout.on("data", (data: Buffer) => {
      server.stdout += data.toString();
      if (server.stdout.length > maxOutput) {
        server.stdout = server.stdout.slice(-maxOutput);
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      server.stderr += text;
      if (server.stderr.length > maxOutput) {
        server.stderr = server.stderr.slice(-maxOutput);
      }
      mirrorStderrChunk(text);
    });

    child.on("close", (code, closeSignal) => {
      server.closed = true;
      if (stderrLineBuffer.tail.length > 0) {
        mirrorStderrChunk("\n");
      }
      appendDebugLog("opencode:server:close", {
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
    appendDebugLog("opencode:spawn", {
      cwd,
      port,
      detached,
      pid: child.pid,
      bin: this.bin,
    });
    server.readyPromise = this.waitForHealthy(server, signal)
      .then(() => {
        appendDebugLog("opencode:server:ready", {
          port,
          elapsedMs: Date.now() - spawnedAt,
        });
      })
      .catch(async (error) => {
        appendDebugLog("opencode:server:ready-failed", {
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

    appendDebugLog("opencode:session:create", { sessionId: response.id });
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
    const streamStartedAt = Date.now();
    appendDebugLog("opencode:stream:start", { sessionId });
    const eventResponse = await this.request(server, "/global/event", {
      method: "GET",
      headers: { accept: "text/event-stream" },
      signal: streamSignal,
    });

    if (!eventResponse.body) {
      appendDebugLog("opencode:stream:no-body", { sessionId });
      throw new Error("opencode returned no event stream body");
    }

    const messagePostStartedAt = Date.now();
    appendDebugLog("opencode:message-post:start", {
      sessionId,
      promptLength: prompt.length,
    });
    let messageRequestError: unknown = null;
    const messageRequest = (async (): Promise<MessageRequestResult> => {
      try {
        await this.request(server, `/session/${sessionId}/prompt_async`, {
          method: "POST",
          body: {
            role: "user",
            parts: [{ type: "text", text: prompt }],
            format: STRUCTURED_OUTPUT_FORMAT,
          },
          signal,
        });
        appendDebugLog("opencode:message-post:end", {
          sessionId,
          elapsedMs: Date.now() - messagePostStartedAt,
        });
        return { ok: true, body: "" };
      } catch (error) {
        messageRequestError = error;
        appendDebugLog("opencode:message-post:error", {
          sessionId,
          elapsedMs: Date.now() - messagePostStartedAt,
          error: serializeError(error),
          serverClosed: server.closed,
          serverStderr: server.stderr.slice(-2048),
          streamTelemetry: buildTelemetry(),
        });
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
    let structuredOutputFromSSE: AgentOutput | null = null;

    // Telemetry: capture "what was happening on the stream right up until
    // the failure" so the debug log can answer questions like "did the
    // model fall silent 4 minutes before the timeout fired?" or "were we
    // stuck in the final_answer phase?"
    const eventCounts: Record<string, number> = {};
    let firstEventAtMs: number | null = null;
    let lastEventAtMs: number | null = null;
    let lastHeartbeatAtMs: number | null = null;
    const phaseTransitions: Array<{ phase: string; atMs: number }> = [];
    let currentPhase: string | null = null;

    const noteEvent = (type: string | undefined) => {
      const key = type ?? "unknown";
      eventCounts[key] = (eventCounts[key] ?? 0) + 1;
      const nowMs = Date.now() - streamStartedAt;
      if (type === "server.heartbeat") {
        lastHeartbeatAtMs = nowMs;
        return;
      }
      if (firstEventAtMs === null) {
        firstEventAtMs = nowMs;
      }
      lastEventAtMs = nowMs;
    };

    const notePhase = (phase: string | undefined) => {
      if (!phase || phase === currentPhase) return;
      currentPhase = phase;
      phaseTransitions.push({ phase, atMs: Date.now() - streamStartedAt });
    };

    const buildTelemetry = (): StreamTelemetry => ({
      eventCounts: { ...eventCounts },
      firstEventAtMs,
      lastEventAtMs,
      lastHeartbeatAtMs,
      msSinceLastEvent:
        lastEventAtMs === null
          ? null
          : Date.now() - streamStartedAt - lastEventAtMs,
      phaseTransitions: [...phaseTransitions],
      currentPhase,
      sawSessionIdle: (eventCounts["session.idle"] ?? 0) > 0,
    });

    // Stall watchdog: if the SSE stream goes silent (no non-heartbeat
    // events) for longer than a threshold, emit a single warning per
    // threshold crossing. This lets the log show silence accumulating in
    // real time rather than only noticing when the final fetch timeout
    // fires.
    const STALL_THRESHOLDS_MS = [60_000, 120_000, 240_000, 480_000];
    let nextStallThresholdIndex = 0;
    const stallTimer = setInterval(() => {
      if (nextStallThresholdIndex >= STALL_THRESHOLDS_MS.length) return;
      const threshold = STALL_THRESHOLDS_MS[nextStallThresholdIndex]!;
      const referencePointMs = lastEventAtMs ?? firstEventAtMs ?? 0;
      const silenceMs = Date.now() - streamStartedAt - referencePointMs;
      if (silenceMs < threshold) return;
      nextStallThresholdIndex += 1;
      appendDebugLog("opencode:stream:stall", {
        sessionId,
        thresholdMs: threshold,
        silenceMs,
        currentPhase,
        lastEventAtMs,
        lastHeartbeatAtMs,
        eventCounts: { ...eventCounts },
      });
    }, 15_000);
    stallTimer.unref?.();

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
      notePhase(phase);
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
        if (properties.info?.structured) {
          structuredOutputFromSSE = properties.info.structured;
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
        noteEvent(event.payload?.type);
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

    let bytesRead = 0;
    try {
      while (!sawSessionIdle) {
        let readResult: ReadableStreamReadResult<Uint8Array>;
        try {
          readResult = await reader.read();
        } catch (error) {
          if (messageRequestError) {
            appendDebugLog("opencode:stream:error", {
              sessionId,
              elapsedMs: Date.now() - streamStartedAt,
              bytesRead,
              reason: "message-post-failed",
              error: serializeError(messageRequestError),
              telemetry: buildTelemetry(),
            });
            if (
              isAbortError(messageRequestError) ||
              isAgentAbortError(messageRequestError)
            ) {
              throw createAbortError();
            }
            throw messageRequestError;
          }
          appendDebugLog("opencode:stream:error", {
            sessionId,
            elapsedMs: Date.now() - streamStartedAt,
            bytesRead,
            reason: "reader-read-failed",
            error: serializeError(error),
            serverClosed: server.closed,
            serverStderr: server.stderr.slice(-2048),
            telemetry: buildTelemetry(),
          });
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
            bytesRead += tail.length;
          }
          processBufferedEvents(true);
          break;
        }

        const chunk = decoder.decode(readResult.value, { stream: true });
        logStream?.write(chunk);
        buffer += chunk;
        bytesRead += chunk.length;
        processBufferedEvents();
      }
    } finally {
      clearInterval(stallTimer);
      streamAbortController.abort();
      await reader.cancel().catch(() => undefined);
    }

    appendDebugLog("opencode:stream:end", {
      sessionId,
      elapsedMs: Date.now() - streamStartedAt,
      bytesRead,
      sawSessionIdle,
      telemetry: buildTelemetry(),
    });

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
    if (body) {
      try {
        JSON.parse(body) as OpenCodeMessageResponse;
      } catch (error) {
        appendDebugLog("opencode:response:parse-error", {
          sessionId,
          bodyLength: body.length,
          bodySample: body.slice(0, 512),
          error: serializeError(error),
        });
      }
    }

    if (structuredOutputFromSSE) {
      appendDebugLog("opencode:output:structured", {
        sessionId,
        source: "sse",
      });
      return {
        output: structuredOutputFromSSE,
        usage,
      };
    }

    const outputText = lastFinalAnswerText ?? lastText;
    if (!outputText) {
      appendDebugLog("opencode:output:missing", {
        sessionId,
        hasStructuredOutput: structuredOutputFromSSE !== null,
      });
      throw new Error("opencode returned no text output");
    }

    try {
      const output = JSON.parse(outputText) as AgentOutput;
      appendDebugLog("opencode:output:structured", {
        sessionId,
        source: lastFinalAnswerText ? "final_answer" : "last_text",
        outputTextLength: outputText.length,
      });
      return {
        output,
        usage,
      };
    } catch (error) {
      appendDebugLog("opencode:output:parse-error", {
        sessionId,
        outputTextLength: outputText.length,
        outputTextSample: outputText.slice(0, 512),
        error: serializeError(error),
      });
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
      appendDebugLog("opencode:session:delete", { sessionId });
    } catch (error) {
      appendDebugLog("opencode:session:delete-failed", {
        sessionId,
        error: serializeError(error),
      });
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
      appendDebugLog("opencode:session:abort", { sessionId });
    } catch (error) {
      appendDebugLog("opencode:session:abort-failed", {
        sessionId,
        error: serializeError(error),
      });
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
    const shutdownStartedAt = Date.now();
    appendDebugLog("opencode:shutdown", {
      cwd: server.cwd,
      port: server.port,
      pid: server.child.pid,
    });

    this.closingPromise = (
      this.platform === "win32" && server.child.pid
        ? killWindowsProcessTree(server.child.pid)
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
      appendDebugLog("opencode:shutdown:done", {
        port: server.port,
        elapsedMs: Date.now() - shutdownStartedAt,
      });
    });

    await this.closingPromise;
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
      appendDebugLog("opencode:request:error", {
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
      appendDebugLog("opencode:request:non-ok", {
        method: options.method,
        path,
        status: response.status,
        elapsedMs: Date.now() - startedAt,
        bodySample: body.slice(0, 1024),
      });
      throw new Error(
        `opencode ${options.method} ${path} failed with ${response.status}: ${body}`,
      );
    }

    return response;
  }
}
