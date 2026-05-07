import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  type AcpRuntimeHandle,
  type AcpRuntimeOptions,
  type AcpRuntimeTurnResult,
  type AcpxRuntime,
} from "acpx/runtime";
import { appendDebugLog, serializeError } from "../debug-log.js";
import { redactAcpTargetForLogs } from "../config.js";
import { parseAgentJson } from "./json-extract.js";
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
  registryOverrides?: Record<string, string>;
  runtimeFactory?: (options: AcpRuntimeOptions) => AcpxRuntimeLike;
}

function buildAcpPrompt(prompt: string, schema: AgentOutputSchema): string {
  return `${prompt}

## gnhf final output contract

When the iteration is complete, your final assistant message must be a single JSON object that matches this JSON Schema. Return only the JSON object. Do not wrap it in Markdown fences. Do not include prose before or after the JSON.

${JSON.stringify(schema, null, 2)}`;
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

function redactRawAcpTargetInString(text: string, target: string): string {
  const redacted = redactAcpTargetForLogs(target);
  if (redacted === target) return text;
  return text.split(target).join(redacted);
}

function redactRawAcpTargetInValue(value: unknown, target: string): unknown {
  if (typeof value === "string") {
    return redactRawAcpTargetInString(value, target);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactRawAcpTargetInValue(item, target));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactRawAcpTargetInValue(entry, target),
      ]),
    );
  }
  return value;
}

function serializeAcpErrorForLog(
  error: unknown,
  target: string,
): Record<string, unknown> {
  return redactRawAcpTargetInValue(serializeError(error), target) as Record<
    string,
    unknown
  >;
}

function redactAcpErrorForThrow(error: unknown, target: string): unknown {
  const redacted = redactAcpTargetForLogs(target);
  if (redacted === target) return error;
  if (error instanceof PermanentAgentError) {
    return new PermanentAgentError(
      redactRawAcpTargetInString(error.message, target),
      redactRawAcpTargetInString(error.detail, target),
    );
  }
  if (error instanceof Error) {
    let cause: unknown;
    try {
      cause = "cause" in error ? error.cause : undefined;
    } catch {
      cause = undefined;
    }
    const redactedCause =
      cause === undefined ? undefined : redactAcpErrorForThrow(cause, target);
    const redactedError = new Error(
      redactRawAcpTargetInString(error.message, target),
      redactedCause === undefined ? undefined : { cause: redactedCause },
    );
    redactedError.name = error.name;
    if (typeof error.stack === "string") {
      redactedError.stack = redactRawAcpTargetInString(error.stack, target);
    }
    const code = (error as { code?: unknown }).code;
    if (code !== undefined) {
      (redactedError as { code?: unknown }).code = code;
    }
    return redactedError;
  }
  return redactRawAcpTargetInValue(error, target);
}

// Rough character-to-token heuristic. ACP's runtime only surfaces a cumulative
// `used` context size via usage_update status events, and many adapters never
// emit those. Estimating from text length gives the user a non-zero, vaguely
// proportional number for both inputs and outputs regardless of adapter.
function estimateTokens(charCount: number): number {
  if (charCount <= 0) return 0;
  return Math.ceil(charCount / 4);
}

// Per-tool-call input-cost heuristic for adapters that don't emit
// usage_update. Each tool call typically returns a payload (file contents,
// command output, edit confirmation) that flows back into the model context
// as input on the next round. 2000 covers a mix of large reads and small
// edits/bash invocations - rough, but orders of magnitude closer to reality
// than counting only the literal initial prompt text.
const ESTIMATED_TOKENS_PER_TOOL_CALL = 2000;

export class AcpAgent implements Agent {
  readonly name: string;

  private readonly target: string;
  private readonly schema: AgentOutputSchema;
  private readonly runId: string;
  private readonly sessionStateDir: string;
  private readonly registryOverrides: Record<string, string> | undefined;
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
    this.registryOverrides = deps.registryOverrides;
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
    let handle: AcpRuntimeHandle;
    try {
      handle = await runtime.ensureSession({
        sessionKey: this.runId,
        agent: this.target,
        mode: "persistent",
        cwd,
      });
    } catch (error) {
      throw redactAcpErrorForThrow(error, this.target);
    }
    this.handle = handle;

    const requestId = randomUUID();
    appendDebugLog("acp:turn:start", {
      target: redactAcpTargetForLogs(this.target),
      sessionKey: this.runId,
      requestId,
      cwd,
    });

    const acpPrompt = buildAcpPrompt(prompt, this.schema);
    const promptTokenEstimate = estimateTokens(acpPrompt.length);

    const startedAt = Date.now();
    const turn = (() => {
      try {
        return runtime.startTurn({
          handle,
          text: acpPrompt,
          mode: "prompt",
          requestId,
          signal,
        });
      } catch (error) {
        appendDebugLog("acp:turn:start-error", {
          target: redactAcpTargetForLogs(this.target),
          requestId,
          elapsedMs: Date.now() - startedAt,
          error: serializeAcpErrorForLog(error, this.target),
        });
        throw redactAcpErrorForThrow(error, this.target);
      }
    })();
    const iterationStartUsed = this.lastReportedUsed;
    let latestUsed = iterationStartUsed;
    // Whether any usage_update status event has set `used` for this run.
    // We track it on the agent (across iterations) because once an adapter
    // has demonstrated it emits usage data, missing events later in the run
    // shouldn't suddenly mark numbers as estimated. Within a single iteration
    // the `iterationStartUsed > 0` check is enough; this flag covers
    // iteration 1 specifically.
    let usageUpdateReceived = iterationStartUsed > 0;
    let toolCallCount = 0;
    let agentOutputChars = 0;
    // Buffer for the in-flight assistant message. ACP adapters stream
    // `agent_message_chunk` notifications as many tiny `text_delta` events
    // (often a few characters each). We accumulate them and only surface the
    // message via `onMessage` when the message is complete - on a tool_call
    // boundary, a stream change, or end of turn.
    let pendingMessage = "";
    let pendingStream: "output" | "thought" | null = null;
    // The most recently completed output-stream message. The agent's final
    // structured JSON answer is supposed to be the last assistant message of
    // the turn, so this is the primary candidate to JSON.parse - separating
    // it from intermediate prose like "Let me examine the code...".
    let lastOutputMessage = "";
    // Concatenation of every output-stream chunk in the turn, used as a
    // fallback when `lastOutputMessage` doesn't parse (e.g. when the agent
    // streams the entire response as one continuous message without any
    // tool_call to break it up).
    let outputBuf = "";
    const logStream = logPath ? createWriteStream(logPath) : null;

    const computeUsage = (): TokenUsage => {
      const usedDelta = Math.max(0, latestUsed - iterationStartUsed);
      // Prefer the adapter's reported context delta when available, since
      // that is the authoritative number. Fall back to prompt + tool-call
      // heuristic so the renderer is never stuck at near-zero for adapters
      // that don't emit usage_update. Tool calls are the dominant input
      // contributor in practice (each one feeds a result back to the model
      // on the next round).
      const fallbackInput =
        promptTokenEstimate + toolCallCount * ESTIMATED_TOKENS_PER_TOOL_CALL;
      const inputTokens = usedDelta > 0 ? usedDelta : fallbackInput;
      const usage: TokenUsage = {
        inputTokens,
        outputTokens: estimateTokens(agentOutputChars),
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };
      if (!usageUpdateReceived) usage.estimated = true;
      return usage;
    };

    const flushPendingMessage = () => {
      if (pendingMessage.length > 0) {
        if (pendingStream === "output") {
          lastOutputMessage = pendingMessage;
        }
        onMessage?.(pendingMessage);
        pendingMessage = "";
      }
      pendingStream = null;
    };

    try {
      // Surface an initial input-token estimate immediately so the renderer
      // shows non-zero numbers as soon as the iteration starts.
      onUsage?.(computeUsage());

      try {
        for await (const event of turn.events) {
          logStream?.write(`${JSON.stringify(event)}\n`);

          if (event.type === "text_delta") {
            const stream = event.stream ?? "output";
            const text = event.text;
            if (!text) continue;
            if (pendingStream !== null && pendingStream !== stream) {
              flushPendingMessage();
            }
            pendingStream = stream;
            pendingMessage += text;
            // Count both output and thought streams toward output tokens -
            // reasoning is real generated text that consumes tokens. Without
            // this, agents that stream reasoning before answering (Gemini,
            // GPT-5, etc.) leave the renderer at 0 output tokens for the
            // entire thinking phase. outputBuf stays output-only because it
            // is used for JSON parsing and reasoning text would corrupt it.
            if (stream === "output") {
              outputBuf += text;
            }
            agentOutputChars += text.length;
            onUsage?.(computeUsage());
            continue;
          }

          if (event.type === "tool_call") {
            // A tool_call ends the in-flight assistant message - flush
            // whatever prose the assistant streamed so far, but don't surface
            // the tool_call text itself. Tool descriptions like
            // "tool call (completed)" are noisy and not useful in the TUI;
            // the user wants to see assistant prose, not mechanics.
            flushPendingMessage();
            // Each tool call (not its many tool_call_update follow-ups) bumps
            // the input-cost heuristic so the fallback estimate scales with
            // actual work. Adapters tag the initial event "tool_call" and
            // later updates "tool_call_update" - count only the former.
            if (event.tag === "tool_call") {
              toolCallCount += 1;
              if (!usageUpdateReceived) onUsage?.(computeUsage());
            }
            continue;
          }

          if (event.type === "status") {
            // Status events are metadata (usage_update, mode change, etc.)
            // and fire frequently mid-stream. Don't surface their text via
            // onMessage - it would flicker over the actual assistant message
            // the user is reading.
            if (typeof event.used === "number" && event.used !== latestUsed) {
              latestUsed = event.used;
              this.lastReportedUsed = latestUsed;
              usageUpdateReceived = true;
              onUsage?.(computeUsage());
            }
            continue;
          }
        }
        flushPendingMessage();
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          await turn.cancel({ reason: "gnhf-aborted" }).catch(() => undefined);
          appendDebugLog("acp:turn:aborted", {
            target: redactAcpTargetForLogs(this.target),
            requestId,
            elapsedMs: Date.now() - startedAt,
          });
          throw createAbortError();
        }
        appendDebugLog("acp:turn:stream-error", {
          target: redactAcpTargetForLogs(this.target),
          requestId,
          elapsedMs: Date.now() - startedAt,
          error: serializeAcpErrorForLog(error, this.target),
        });
        throw redactAcpErrorForThrow(error, this.target);
      }

      const result: AcpRuntimeTurnResult = await turn.result;
      appendDebugLog("acp:turn:result", {
        target: redactAcpTargetForLogs(this.target),
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
        const message = redactRawAcpTargetInString(
          result.error.message || "ACP turn failed",
          this.target,
        );
        if (result.error.retryable === false) {
          throw new PermanentAgentError(
            message,
            result.error.code ?? "ACP_TURN_FAILED",
          );
        }
        throw new Error(message);
      }

      if (lastOutputMessage.length === 0 && outputBuf.length === 0) {
        throw new Error("ACP agent returned no output text");
      }

      // Try the most recent assistant message first - that's where the
      // structured answer is supposed to live. Fall back to extracting a
      // JSON object out of the full output stream if the last message
      // alone doesn't parse (e.g. the agent streamed prose and JSON in
      // one uninterrupted message, so we have to dig the JSON out).
      let parsed = parseAgentJson(lastOutputMessage);
      if (parsed === null && outputBuf !== lastOutputMessage) {
        parsed = parseAgentJson(outputBuf);
      }
      if (parsed === null) {
        const preview = (lastOutputMessage || outputBuf).slice(0, 200);
        throw new Error(
          `Failed to parse ACP agent output as JSON. Last assistant message started with: ${JSON.stringify(preview)}`,
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
      appendDebugLog("acp:close", {
        target: redactAcpTargetForLogs(this.target),
      });
    } catch (error) {
      appendDebugLog("acp:close-error", {
        target: redactAcpTargetForLogs(this.target),
        error: serializeAcpErrorForLog(error, this.target),
      });
    }
  }

  private ensureRuntime(cwd: string): AcpxRuntimeLike {
    if (this.runtime) return this.runtime;
    const runtime = this.runtimeFactory({
      cwd,
      sessionStore: createFileSessionStore({ stateDir: this.sessionStateDir }),
      agentRegistry: createAgentRegistry(
        this.registryOverrides
          ? { overrides: this.registryOverrides }
          : undefined,
      ),
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
    });
    this.runtime = runtime;
    appendDebugLog("acp:runtime:created", {
      target: redactAcpTargetForLogs(this.target),
      sessionStateDir: this.sessionStateDir,
      cwd,
    });
    return runtime;
  }
}
