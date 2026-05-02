import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
  type AcpRuntimeOptions,
  type AcpRuntimeTurnResult,
  type AcpxRuntime,
} from "acpx/runtime";
import { appendDebugLog, serializeError } from "../debug-log.js";
import {
  PermanentAgentError,
  validateAgentOutput,
  type Agent,
  type AgentOutputSchema,
  type AgentResult,
  type AgentRunOptions,
  type TokenUsage,
} from "./types.js";

/**
 * Subset of `AcpxRuntime` that AcpAgent depends on. Declared here so tests
 * can stub the runtime without pulling in the real acpx implementation.
 */
type AcpxRuntimeLike = Pick<
  AcpxRuntime,
  "ensureSession" | "startTurn" | "close"
>;

export interface AcpAgentDeps {
  target: string;
  schema: AgentOutputSchema;
  runId: string;
  sessionStateDir: string;
  runtimeFactory?: (options: AcpRuntimeOptions) => AcpxRuntimeLike;
}

function buildAcpPrompt(prompt: string, schema: AgentOutputSchema): string {
  return `${prompt}

## gnhf final output contract

When the iteration is complete, your final assistant message must be a single JSON object that matches this JSON Schema. Return only the JSON object. Do not wrap it in Markdown fences. Do not include prose before or after the JSON.

${JSON.stringify(schema, null, 2)}`;
}

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;

  const withoutOpen = trimmed.replace(/^```(?:json)?\s*\n?/, "");
  return withoutOpen.replace(/\n?```\s*$/, "").trim();
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message === "Agent was aborted")
  );
}

function createAbortError(): Error {
  return new Error("Agent was aborted");
}

export class AcpAgent implements Agent {
  readonly name: string;

  private readonly target: string;
  private readonly schema: AgentOutputSchema;
  private readonly runId: string;
  private readonly sessionStateDir: string;
  private readonly runtimeFactory: (
    options: AcpRuntimeOptions,
  ) => AcpxRuntimeLike;

  private runtime: AcpxRuntimeLike | null = null;
  private handle: AcpRuntimeHandle | null = null;
  private closing: Promise<void> | null = null;
  private closed = false;
  // Tracks the most recent `used` value reported by the adapter's
  // usage_update status events. The ACP session is persistent across
  // iterations, so `used` is cumulative — we report per-iteration deltas.
  private lastReportedUsed = 0;

  constructor(deps: AcpAgentDeps) {
    this.target = deps.target;
    this.schema = deps.schema;
    this.runId = deps.runId;
    this.sessionStateDir = deps.sessionStateDir;
    this.runtimeFactory =
      deps.runtimeFactory ?? ((options) => createAcpRuntime(options));
    this.name = `acp:${deps.target}`;
  }

  async run(
    prompt: string,
    cwd: string,
    options?: AgentRunOptions,
  ): Promise<AgentResult> {
    if (this.closed) {
      throw new Error("AcpAgent has been closed");
    }

    const { signal, onMessage, onUsage, logPath } = options ?? {};
    if (signal?.aborted) {
      throw createAbortError();
    }

    const runtime = this.ensureRuntime(cwd);
    const handle = await runtime.ensureSession({
      sessionKey: this.runId,
      agent: this.target,
      mode: "persistent",
      cwd,
    });
    this.handle = handle;

    const requestId = randomUUID();
    appendDebugLog("acp:turn:start", {
      target: this.target,
      sessionKey: this.runId,
      requestId,
      cwd,
    });

    const turn = runtime.startTurn({
      handle,
      text: buildAcpPrompt(prompt, this.schema),
      mode: "prompt",
      requestId,
      signal,
    });

    const startedAt = Date.now();
    let outputBuf = "";
    const iterationStartUsed = this.lastReportedUsed;
    let latestUsed = iterationStartUsed;
    const logStream = logPath ? createWriteStream(logPath) : null;
    const computeUsage = (): TokenUsage => ({
      inputTokens: Math.max(0, latestUsed - iterationStartUsed),
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });

    try {
      try {
        for await (const event of turn.events) {
          logStream?.write(`${JSON.stringify(event)}\n`);
          const outputChunk = this.routeEvent(event, onMessage);
          if (outputChunk) outputBuf += outputChunk;
          if (
            event.type === "status" &&
            typeof event.used === "number" &&
            event.used !== latestUsed
          ) {
            latestUsed = event.used;
            this.lastReportedUsed = latestUsed;
            onUsage?.(computeUsage());
          }
        }
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          await turn.cancel({ reason: "gnhf-aborted" }).catch(() => undefined);
          appendDebugLog("acp:turn:aborted", {
            target: this.target,
            requestId,
            elapsedMs: Date.now() - startedAt,
          });
          throw createAbortError();
        }
        appendDebugLog("acp:turn:stream-error", {
          target: this.target,
          requestId,
          elapsedMs: Date.now() - startedAt,
          error: serializeError(error),
        });
        throw error;
      }

      const result: AcpRuntimeTurnResult = await turn.result;
      appendDebugLog("acp:turn:result", {
        target: this.target,
        requestId,
        status: result.status,
        stopReason:
          result.status === "completed" || result.status === "cancelled"
            ? result.stopReason
            : undefined,
        errorCode: result.status === "failed" ? result.error.code : undefined,
        retryable:
          result.status === "failed" ? result.error.retryable : undefined,
        elapsedMs: Date.now() - startedAt,
        outputLength: outputBuf.length,
      });

      if (result.status === "cancelled") {
        throw createAbortError();
      }
      if (result.status === "failed") {
        const message = result.error.message || "ACP turn failed";
        if (result.error.retryable === false) {
          throw new PermanentAgentError(
            message,
            result.error.code ?? "ACP_TURN_FAILED",
          );
        }
        throw new Error(message);
      }

      const cleanedText = stripJsonFences(outputBuf);
      if (cleanedText.length === 0) {
        throw new Error("ACP agent returned no output text");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(cleanedText);
      } catch (error) {
        throw new Error(
          `Failed to parse ACP agent output as JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      const output = validateAgentOutput(parsed, this.schema);
      return { output, usage: computeUsage() };
    } finally {
      logStream?.end();
    }
  }

  async close(): Promise<void> {
    if (this.closing) {
      await this.closing;
      return;
    }
    if (this.closed) return;
    this.closing = this.shutdown();
    try {
      await this.closing;
    } finally {
      this.closing = null;
    }
  }

  private async shutdown(): Promise<void> {
    this.closed = true;
    if (!this.runtime || !this.handle) return;

    const runtime = this.runtime;
    const handle = this.handle;
    this.runtime = null;
    this.handle = null;
    try {
      await runtime.close({ handle, reason: "gnhf-shutdown" });
      appendDebugLog("acp:close", { target: this.target });
    } catch (error) {
      appendDebugLog("acp:close-error", {
        target: this.target,
        error: serializeError(error),
      });
    }
  }

  private ensureRuntime(cwd: string): AcpxRuntimeLike {
    if (this.runtime) return this.runtime;
    const runtime = this.runtimeFactory({
      cwd,
      sessionStore: createFileSessionStore({ stateDir: this.sessionStateDir }),
      agentRegistry: createAgentRegistry(),
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
    });
    this.runtime = runtime;
    appendDebugLog("acp:runtime:created", {
      target: this.target,
      sessionStateDir: this.sessionStateDir,
      cwd,
    });
    return runtime;
  }

  /**
   * Surface live progress to the renderer via onMessage and report the
   * portion (if any) that should be accumulated as the final JSON answer.
   *
   * We only include `text_delta` with `stream: "output"` in the buffer that
   * we later JSON.parse. Thoughts, tool calls, and status updates flow to
   * onMessage so the user sees progress, but never into the answer buffer.
   */
  private routeEvent(
    event: AcpRuntimeEvent,
    onMessage?: (text: string) => void,
  ): string | undefined {
    if (event.type === "text_delta") {
      const stream = event.stream ?? "output";
      const text = event.text;
      if (text && text.length > 0) onMessage?.(text);
      return stream === "output" ? text : undefined;
    }

    if (event.type === "tool_call" || event.type === "status") {
      const text = event.text;
      if (text && text.length > 0) onMessage?.(text);
    }
    return undefined;
  }
}
