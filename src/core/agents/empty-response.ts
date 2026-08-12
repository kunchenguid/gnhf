import { appendDebugLog, serializeError } from "../debug-log.js";
import { PermanentAgentError } from "./types.js";
import type { AgentResult, OnUsage, TokenUsage } from "./types.js";

export const EMPTY_RESPONSE_CONTINUATION_PROMPT =
  "You did not produce a final answer. Continue and provide your final summary now.";

/**
 * Thrown by an adapter when a turn produced no final message. `turnCompleted`
 * separates "the agent finished its turn and simply said nothing" - which one
 * continuation nudge can recover - from "the transport died before the turn
 * ended", where nudging would post into a session that is still working (or
 * gone) and would replace a clear diagnostic with a transport error.
 *
 * `usage` is what the empty turn actually cost. It is required so the tokens
 * burned by a turn that never returned an `AgentResult` stay part of the
 * iteration total instead of depending on whichever `onUsage` callback the
 * adapter happened to fire last.
 */
export class EmptyAgentResponseError extends Error {
  readonly turnCompleted: boolean;
  readonly usage: TokenUsage;

  constructor(
    message: string,
    options: { turnCompleted: boolean; usage: TokenUsage; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "EmptyAgentResponseError";
    this.turnCompleted = options.turnCompleted;
    this.usage = { ...options.usage };
  }
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

export function addTokenUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  const total: TokenUsage = {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheCreationTokens: left.cacheCreationTokens + right.cacheCreationTokens,
  };
  if (left.estimated || right.estimated) {
    total.estimated = true;
  }
  return total;
}

export interface EmptyResponseRetryOptions {
  /** Debug-log event name recorded when the nudge is sent. */
  logEvent: string;
  logFields?: Record<string, unknown>;
  onUsage?: OnUsage;
  signal?: AbortSignal;
  combineUsage?: (left: TokenUsage, right: TokenUsage) => TokenUsage;
  /**
   * Text for the first turn. The continuation turn is always the bare nudge -
   * adapters that cannot parse a bare turn apply their own existing prompt
   * scaffolding inside `runTurn` so both turns are wrapped identically.
   */
  initialText: string;
  runTurn: (text: string, onTurnUsage: OnUsage) => Promise<AgentResult>;
}

/**
 * Runs one turn and, if it completed without a final message, runs exactly one
 * bare continuation turn. Usage reported to `onUsage` stays cumulative across
 * both turns; any other failure propagates untouched.
 *
 * If the continuation itself fails for a reason unrelated to the empty response
 * - a CLI that refuses the resume command, say - the original empty-response
 * diagnostic is what the user gets, with the continuation failure attached as
 * `cause` and recorded in the run log. Recovery is best effort, so a broken
 * continuation must never overwrite the accurate description of what went
 * wrong. Aborts and permanent errors still propagate so `--max-tokens`, Ctrl+C,
 * and abort-worthy provider failures behave exactly as before.
 */
export async function runTurnWithEmptyResponseRetry({
  logEvent,
  logFields,
  onUsage,
  signal,
  combineUsage = addTokenUsage,
  initialText,
  runTurn,
}: EmptyResponseRetryOptions): Promise<AgentResult> {
  try {
    return await runTurn(initialText, (usage) => onUsage?.(usage));
  } catch (error) {
    if (!(error instanceof EmptyAgentResponseError) || !error.turnCompleted) {
      throw error;
    }

    const firstTurnUsage = error.usage;
    onUsage?.({ ...firstTurnUsage });
    if (signal?.aborted) {
      throw createAbortError();
    }

    appendDebugLog(logEvent, {
      ...logFields,
      attempt: 1,
      prompt: EMPTY_RESPONSE_CONTINUATION_PROMPT,
    });

    let retry: AgentResult;
    try {
      retry = await runTurn(EMPTY_RESPONSE_CONTINUATION_PROMPT, (usage) => {
        onUsage?.(combineUsage(firstTurnUsage, usage));
      });
    } catch (continuationError) {
      if (continuationError instanceof EmptyAgentResponseError) {
        const cumulativeUsage = combineUsage(
          firstTurnUsage,
          continuationError.usage,
        );
        onUsage?.({ ...cumulativeUsage });
        throw new EmptyAgentResponseError(
          signal?.aborted ? "Agent was aborted" : continuationError.message,
          {
            turnCompleted: continuationError.turnCompleted,
            usage: cumulativeUsage,
            cause: continuationError,
          },
        );
      }

      if (
        continuationError instanceof PermanentAgentError ||
        isAbortError(continuationError)
      ) {
        throw continuationError;
      }

      appendDebugLog(logEvent, {
        ...logFields,
        attempt: 1,
        continuationFailed: true,
        error: serializeError(continuationError),
      });

      throw new EmptyAgentResponseError(error.message, {
        turnCompleted: error.turnCompleted,
        usage: firstTurnUsage,
        cause: continuationError,
      });
    }

    if (signal?.aborted) {
      throw createAbortError();
    }

    return {
      output: retry.output,
      usage: combineUsage(firstTurnUsage, retry.usage),
    };
  }
}
