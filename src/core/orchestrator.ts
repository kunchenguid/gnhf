import { EventEmitter } from "node:events";
import { join } from "node:path";
import {
  PermanentAgentError,
  RateLimitAgentError,
  type Agent,
  type AgentOutput,
  type TokenUsage,
  type UsageOverage,
} from "./agents/types.js";
import { redactAgentSpecForLogs, type Config } from "./config.js";
import type { RunInfo } from "./run.js";
import { appendNotes, toStringArray } from "./run.js";
import { appendDebugLog, serializeError } from "./debug-log.js";
import {
  CommitFailedError,
  commitAll,
  getBranchCommitCount,
  getCurrentBranch,
  getHeadCommit,
  pushCurrentBranch,
  resetHard,
} from "./git.js";
import {
  getInterruptDisposition,
  getInterruptHint,
  type InterruptDisposition,
  type InterruptHint,
} from "./interrupt-state.js";
import { buildCommitMessage } from "./commit-message.js";
import { buildIterationPrompt } from "../templates/iteration-prompt.js";
import { getTotalTokenCount } from "../utils/tokens.js";

export interface IterationRecord {
  number: number;
  success: boolean;
  summary: string;
  keyChanges: string[];
  keyLearnings: string[];
  timestamp: Date;
}

export type { InterruptDisposition, InterruptHint } from "./interrupt-state.js";

export interface OrchestratorState {
  status: "running" | "waiting" | "aborted" | "stopped";
  gracefulStopRequested: boolean;
  interruptHint: InterruptHint;
  currentIteration: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  // Sticky flag: true when at least one iteration's usage was reported as
  // estimated (e.g. an ACP adapter that doesn't emit usage_update). Once set,
  // it stays set for the rest of the run so totals are presented honestly.
  tokensEstimated: boolean;
  commitCount: number;
  iterations: IterationRecord[];
  successCount: number;
  failCount: number;
  consecutiveFailures: number;
  consecutiveErrors: number;
  startTime: Date;
  waitingUntil: Date | null;
  lastMessage: string | null;
  lastAgentError?: string | null;
  hasPendingCommitFailure?: boolean;
}

export interface OrchestratorEvents {
  state: [OrchestratorState];
  "iteration:start": [number];
  "iteration:end": [IterationRecord];
  abort: [string];
  stopped: [];
}

export interface RunLimits {
  fallbackModel?: string;
  maxIterations?: number;
  maxTokens?: number;
  maxRateLimitWaitMs?: number;
  stopWhen?: string;
  push?: boolean;
}

const STOP_CLOSE_AGENT_GRACE_MS = 250;

// Resume a rate-limited run a little after the provider-reported reset so
// clock skew or a still-warming limiter doesn't waste the retry.
const RATE_LIMIT_RESUME_BUFFER_MS = 60_000;
// Fallback wait when the reset time is missing or already past, escalating
// per consecutive rate-limited attempt so a stale reset time can't spin the
// loop, and bounded so recovery is never far away.
const RATE_LIMIT_MIN_WAIT_MS = 60_000;
const RATE_LIMIT_MAX_FALLBACK_WAIT_MS = 30 * 60_000;
// Cap provider-derived waits well under Node's 2^31-1 ms setTimeout limit -
// larger delays fire after ~1 ms, turning a far-future reset (e.g. a monthly
// limit) into a hot retry loop. A capped wait ends before the window actually
// returns, so resuming on it is a probe: free after a rejection, which re-reads
// the reset time and self-corrects in daily chunks, but a billed iteration
// after overage, which fails closed instead.
const RATE_LIMIT_MAX_WAIT_MS = 24 * 60 * 60_000;
const DEFAULT_RATE_LIMIT_MAX_WAIT_MS = RATE_LIMIT_MAX_WAIT_MS;

type ProviderResumeWait =
  | { kind: "none" }
  | { kind: "elapsed"; resumeAt: Date }
  | { kind: "wait"; resumeAt: Date; waitMs: number; truncated: boolean };

type RunIterationResult =
  | {
      type: "completed";
      record: IterationRecord;
      shouldFullyStop: boolean;
      abortReason?: string;
    }
  | { type: "stopped" }
  | { type: "aborted"; reason: string }
  | { type: "rate-limited"; resumeAt: Date | null; message: string };

export class Orchestrator extends EventEmitter<OrchestratorEvents> {
  private config: Config;
  private agent: Agent;
  private runInfo: RunInfo;
  private cwd: string;
  private prompt: string;
  private limits: RunLimits;
  private stopRequested = false;
  private stopPromise: Promise<void> | null = null;
  private activeIterationPromise: Promise<RunIterationResult> | null = null;
  private activeAbortController: AbortController | null = null;
  private pendingAbortReason: string | null = null;
  private pendingCommitFailure: string | null = null;
  private activeIterationTokensEstimated = false;
  private activeIterationOverage: UsageOverage | null = null;
  private fallbackModelActive = false;
  private fallbackModelUsed = false;
  private consecutiveRateLimitWaits = 0;
  private totalRateLimitWaitMs = 0;
  private loopDone = false;
  private stoppedEventEmitted = false;

  private state: Omit<
    OrchestratorState,
    "interruptHint" | "hasPendingCommitFailure"
  > = {
    status: "running",
    gracefulStopRequested: false,
    currentIteration: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    tokensEstimated: false,
    commitCount: 0,
    iterations: [],
    successCount: 0,
    failCount: 0,
    consecutiveFailures: 0,
    consecutiveErrors: 0,
    startTime: new Date(),
    waitingUntil: null,
    lastMessage: null,
    lastAgentError: null,
  };

  constructor(
    config: Config,
    agent: Agent,
    runInfo: RunInfo,
    prompt: string,
    cwd: string,
    startIteration = 0,
    limits: RunLimits = {},
  ) {
    super();
    this.config = config;
    this.agent = agent;
    this.runInfo = runInfo;
    this.prompt = prompt;
    this.cwd = cwd;
    this.limits = {
      ...limits,
      maxRateLimitWaitMs:
        limits.maxRateLimitWaitMs ?? DEFAULT_RATE_LIMIT_MAX_WAIT_MS,
    };
    this.state.currentIteration = startIteration;
    this.state.commitCount = getBranchCommitCount(
      this.runInfo.baseCommit,
      this.cwd,
    );
  }

  getState(): OrchestratorState {
    return {
      ...this.state,
      tokensEstimated:
        this.state.tokensEstimated || this.activeIterationTokensEstimated,
      interruptHint: getInterruptHint(this.state),
      hasPendingCommitFailure: this.pendingCommitFailure !== null,
    };
  }

  requestGracefulStop(): void {
    if (
      this.stopRequested ||
      this.state.gracefulStopRequested ||
      this.loopDone
    ) {
      return;
    }

    this.state.gracefulStopRequested = true;
    appendDebugLog("orchestrator:graceful-stop-requested", {
      iteration: this.state.currentIteration,
      hasActiveIteration: this.activeIterationPromise !== null,
      status: this.state.status,
    });
    this.emit("state", this.getState());

    if (this.state.status === "waiting") {
      this.activeAbortController?.abort();
    }
  }

  handleInterrupt(): InterruptDisposition {
    const disposition = getInterruptDisposition(this.state);
    if (disposition === "request-graceful-stop") {
      this.requestGracefulStop();
    } else if (disposition === "force-stop") {
      this.stop();
    }
    return disposition;
  }

  stop(): void {
    this.stopRequested = true;
    appendDebugLog("orchestrator:stop-requested", {
      iteration: this.state.currentIteration,
      hasActiveIteration: this.activeIterationPromise !== null,
      loopDone: this.loopDone,
    });
    this.activeAbortController?.abort();
    this.state.gracefulStopRequested = false;

    if (this.loopDone) {
      this.emitStopped();
      return;
    }

    if (this.stopPromise) return;

    this.stopPromise = (async () => {
      if (this.activeIterationPromise) {
        const iterationPromise = this.activeIterationPromise.catch(
          () => undefined,
        );
        await new Promise<void>((resolve) => {
          let settled = false;
          const settle = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(settle, STOP_CLOSE_AGENT_GRACE_MS);
          timer.unref?.();
          void iterationPromise.finally(settle);
        });
        await this.closeAgent();
        await iterationPromise;
      } else {
        await this.closeAgent();
      }
      resetHard(this.cwd);
      this.pendingCommitFailure = null;
      this.state.status = "stopped";
      this.emit("state", this.getState());
      this.emitStopped();
    })();
  }

  async start(): Promise<void> {
    this.state.startTime = new Date();
    this.state.status = "running";
    // Preserve a pre-start graceful-stop request. ctrl+c can land after the
    // renderer starts listening but before the orchestrator loop begins.
    this.emit("state", this.getState());

    appendDebugLog("orchestrator:start", {
      agent: redactAgentSpecForLogs(this.agent.name),
      runId: this.runInfo.runId,
      startIteration: this.state.currentIteration,
      maxIterations: this.limits.maxIterations,
      maxTokens: this.limits.maxTokens,
      maxRateLimitWaitMs: this.limits.maxRateLimitWaitMs,
      push: this.limits.push === true,
      maxConsecutiveFailures: this.config.maxConsecutiveFailures,
      baseCommit: this.runInfo.baseCommit,
      initialCommitCount: this.state.commitCount,
    });

    try {
      while (!this.stopRequested) {
        const preIterationAbortReason = this.getPreIterationAbortReason();
        if (preIterationAbortReason) {
          this.abort(preIterationAbortReason);
          break;
        }
        if (this.stopForGracefulShutdown()) {
          break;
        }

        this.state.currentIteration++;
        this.state.status = "running";
        this.emit("iteration:start", this.state.currentIteration);
        this.emit("state", this.getState());

        const baseIterationPrompt = buildIterationPrompt({
          n: this.state.currentIteration,
          runId: this.runInfo.runId,
          prompt: this.prompt,
          stopWhen: this.limits.stopWhen,
          commitMessage: this.config.commitMessage,
        });
        const iterationPrompt = this.pendingCommitFailure
          ? this.buildCommitRepairPrompt(baseIterationPrompt)
          : baseIterationPrompt;

        appendDebugLog("iteration:start", {
          iteration: this.state.currentIteration,
          promptLength: iterationPrompt.length,
          consecutiveFailures: this.state.consecutiveFailures,
          totalInputTokens: this.state.totalInputTokens,
          totalOutputTokens: this.state.totalOutputTokens,
          git: this.snapshotGitState(),
        });

        const iterationStartedAt = Date.now();
        this.activeIterationPromise = this.runIteration(iterationPrompt);
        const result = await this.activeIterationPromise;
        this.activeIterationPromise = null;
        const iterationElapsedMs = Date.now() - iterationStartedAt;

        if (result.type === "stopped") {
          appendDebugLog("iteration:stopped", {
            iteration: this.state.currentIteration,
            elapsedMs: iterationElapsedMs,
          });
          break;
        }
        if (result.type === "aborted") {
          appendDebugLog("iteration:aborted", {
            iteration: this.state.currentIteration,
            elapsedMs: iterationElapsedMs,
            reason: result.reason,
          });
          this.abort(result.reason);
          break;
        }

        if (result.type === "rate-limited") {
          if (
            this.limits.fallbackModel !== undefined &&
            !this.fallbackModelUsed
          ) {
            this.fallbackModelActive = true;
            this.fallbackModelUsed = true;
            this.consecutiveRateLimitWaits = 0;
            this.state.currentIteration--;
            this.state.lastAgentError = null;
            this.state.lastMessage = `switching to fallback model ${this.limits.fallbackModel}`;
            appendDebugLog("rate-limit:fallback-model", {
              iteration: this.state.currentIteration + 1,
              model: this.limits.fallbackModel,
            });
            this.emit("state", this.getState());
            continue;
          }
          // The attempt did no work; retry under the same iteration number so
          // rate-limit waits don't consume --max-iterations or the
          // consecutive-failure budget. A reset time that cannot be waited for
          // costs only a wasted retry here, so fall back to escalating backoff
          // and probe again.
          this.consecutiveRateLimitWaits++;
          const rejectionWait = this.providerResumeWait(result.resumeAt);
          const outcome = await this.waitForUsageWindowReset({
            waitMs:
              rejectionWait.kind === "wait"
                ? rejectionWait.waitMs
                : this.fallbackResumeWaitMs(),
            resumeAt: result.resumeAt,
            logPrefix: "rate-limit",
            message: result.message,
            rollBackIteration: true,
            clearAgentErrorOnAbort: false,
          });
          if (outcome === "stop") {
            break;
          }
          continue;
        }

        this.consecutiveRateLimitWaits = 0;
        const { record } = result;
        this.state.iterations.push(record);
        this.emit("iteration:end", record);
        this.emit("state", this.getState());

        appendDebugLog("iteration:end", {
          iteration: record.number,
          elapsedMs: iterationElapsedMs,
          success: record.success,
          summary: record.summary,
          keyChanges: record.keyChanges.length,
          keyLearnings: record.keyLearnings.length,
          consecutiveFailures: this.state.consecutiveFailures,
          totalInputTokens: this.state.totalInputTokens,
          totalOutputTokens: this.state.totalOutputTokens,
          tokensEstimated: this.state.tokensEstimated,
          commitCount: this.state.commitCount,
        });

        if (result.abortReason) {
          this.abort(result.abortReason);
          break;
        }

        if (this.stopForGracefulShutdown()) {
          break;
        }

        if (this.limits.stopWhen !== undefined && result.shouldFullyStop) {
          this.abort("stop condition met");
          break;
        }

        const postIterationAbortReason = this.getPostIterationAbortReason();
        if (postIterationAbortReason) {
          this.abort(postIterationAbortReason);
          break;
        }

        if (
          this.state.consecutiveFailures >= this.config.maxConsecutiveFailures
        ) {
          this.abort(
            `${this.config.maxConsecutiveFailures} consecutive failures`,
          );
          break;
        }

        const overage = this.activeIterationOverage;
        if (overage && !this.stopRequested) {
          // The included window is spent and the provider is billing extra
          // usage instead of rejecting. This iteration's work is already
          // committed, so keep it and wait for the reset rather than buying
          // the next one. Deciding here, after the post-iteration checks but
          // before any backoff of gnhf's own, means a run that was going to
          // stop anyway never sleeps first and a pause we choose to take can
          // never consume a reset time that was usable when it arrived.
          // A reset time that has already elapsed says the included window is
          // back - a long iteration routinely outlives its own reset - so the
          // run just continues; if the provider is still billing, the next
          // iteration reports overage again with a fresh reset time. Only a
          // reset nothing can be done with, none reported or one so far out
          // the wait would end short of it, leaves probing as the alternative,
          // and probing buys a billed iteration every time, so those fail
          // closed.
          const wait = this.providerResumeWait(overage.resumeAt);
          if (
            wait.kind === "none" ||
            (wait.kind === "wait" && wait.truncated)
          ) {
            appendDebugLog("overage:wait:unusable-reset", {
              iteration: this.state.currentIteration,
              resumeAt:
                wait.kind === "none" ? null : wait.resumeAt.toISOString(),
              truncated: wait.kind === "wait",
            });
            this.state.lastAgentError = null;
            this.abort(
              `extra usage engaged but ${
                wait.kind === "none"
                  ? "no reset time was reported"
                  : `the reported reset time (${wait.resumeAt.toISOString()}) is further out than a single wait can cover`
              }`,
            );
            break;
          }
          if (wait.kind === "elapsed") {
            appendDebugLog("overage:window-returned", {
              iteration: this.state.currentIteration,
              resumeAt: wait.resumeAt.toISOString(),
            });
          } else {
            const outcome = await this.waitForUsageWindowReset({
              waitMs: wait.waitMs,
              resumeAt: wait.resumeAt,
              logPrefix: "overage",
              message: `extra usage engaged - waiting for the usage window to reset at ${wait.resumeAt.toISOString()}`,
              rollBackIteration: false,
              clearAgentErrorOnAbort: true,
            });
            if (outcome === "stop") {
              break;
            }
          }
        }

        if (this.state.consecutiveErrors > 0 && !this.stopRequested) {
          const backoffMs =
            60_000 * Math.pow(2, this.state.consecutiveErrors - 1);
          this.state.status = "waiting";
          this.state.waitingUntil = new Date(Date.now() + backoffMs);
          this.emit("state", this.getState());

          appendDebugLog("backoff:start", {
            iteration: this.state.currentIteration,
            consecutiveErrors: this.state.consecutiveErrors,
            backoffMs,
          });

          await this.interruptibleSleep(backoffMs);

          appendDebugLog("backoff:end", {
            iteration: this.state.currentIteration,
            stopRequested: this.stopRequested,
          });

          this.state.waitingUntil = null;
          if (!this.stopRequested) {
            if (this.stopForGracefulShutdown()) {
              break;
            }
            this.state.status = "running";
            this.emit("state", this.getState());
          }
        }
      }
    } catch (err) {
      appendDebugLog("orchestrator:loop-error", {
        iteration: this.state.currentIteration,
        error: serializeError(err),
      });
      throw err;
    } finally {
      this.activeIterationPromise = null;
      if (this.stopPromise) {
        await this.stopPromise;
      } else {
        await this.closeAgent();
      }
      this.loopDone = true;
      if (this.didStopWithoutForce()) {
        this.emitStopped();
      }
      appendDebugLog("orchestrator:end", {
        status: this.state.status,
        iterations: this.state.currentIteration,
        successCount: this.state.successCount,
        failCount: this.state.failCount,
        totalInputTokens: this.state.totalInputTokens,
        totalOutputTokens: this.state.totalOutputTokens,
        commitCount: this.state.commitCount,
      });
    }
  }

  private async runIteration(prompt: string): Promise<RunIterationResult> {
    const baseInputTokens = this.state.totalInputTokens;
    const baseOutputTokens = this.state.totalOutputTokens;
    const baseCacheReadTokens = this.state.totalCacheReadTokens;
    const baseCacheCreationTokens = this.state.totalCacheCreationTokens;

    this.activeAbortController = new AbortController();
    this.pendingAbortReason = null;
    this.activeIterationTokensEstimated = false;
    this.activeIterationOverage = null;

    const onUsage = (usage: TokenUsage) => {
      this.state.totalInputTokens = baseInputTokens + usage.inputTokens;
      this.state.totalOutputTokens = baseOutputTokens + usage.outputTokens;
      this.state.totalCacheReadTokens =
        baseCacheReadTokens + usage.cacheReadTokens;
      this.state.totalCacheCreationTokens =
        baseCacheCreationTokens + usage.cacheCreationTokens;
      this.activeIterationTokensEstimated = usage.estimated === true;
      this.emit("state", this.getState());

      const reason = this.getTokenAbortReason();
      if (
        reason &&
        this.activeAbortController &&
        !this.activeAbortController.signal.aborted
      ) {
        this.pendingAbortReason = reason;
        this.activeAbortController.abort();
      }
    };

    const onMessage = (text: string) => {
      this.state.lastMessage = text;
      this.emit("state", this.getState());
    };

    // Agents report overage out-of-band so it survives a terminal path that
    // throws: an iteration that failed after the included window was spent
    // must still pause instead of buying the next one.
    const onOverage = (overage: UsageOverage | null) => {
      this.activeIterationOverage = overage;
    };

    const logPath = join(
      this.runInfo.runDir,
      `iteration-${this.state.currentIteration}.jsonl`,
    );

    const agentStartedAt = Date.now();
    appendDebugLog("agent:run:start", {
      iteration: this.state.currentIteration,
      agent: redactAgentSpecForLogs(this.agent.name),
      logPath,
    });

    const fallbackModel = this.fallbackModelActive
      ? this.limits.fallbackModel
      : undefined;
    this.fallbackModelActive = false;

    try {
      const result = await this.agent.run(prompt, this.cwd, {
        ...(fallbackModel === undefined ? {} : { model: fallbackModel }),
        onUsage,
        onMessage,
        onOverage,
        signal: this.activeAbortController.signal,
        logPath,
      });

      this.activeIterationTokensEstimated = false;
      if (result.usage.estimated) this.state.tokensEstimated = true;

      if (this.pendingAbortReason) {
        appendDebugLog("agent:run:aborted", {
          iteration: this.state.currentIteration,
          elapsedMs: Date.now() - agentStartedAt,
          reason: this.pendingAbortReason,
        });
        if (this.pendingCommitFailure === null) {
          resetHard(this.cwd);
        }
        return { type: "aborted", reason: this.pendingAbortReason };
      }

      appendDebugLog("agent:run:end", {
        iteration: this.state.currentIteration,
        elapsedMs: Date.now() - agentStartedAt,
        success: result.output.success,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        cacheCreationTokens: result.usage.cacheCreationTokens,
        estimated: result.usage.estimated ?? false,
      });

      if (this.stopRequested) {
        return { type: "stopped" };
      }

      const shouldFullyStop = result.output.should_fully_stop === true;

      if (result.output.success) {
        const record = this.recordSuccess(result.output);
        const abortReason =
          record.success && this.limits.push === true
            ? this.pushAfterSuccess()
            : undefined;
        return {
          type: "completed",
          record,
          shouldFullyStop: record.success ? shouldFullyStop : false,
          ...(abortReason === undefined ? {} : { abortReason }),
        };
      }
      return {
        type: "completed",
        record: this.recordFailure(
          `[FAIL] ${result.output.summary}`,
          result.output.summary,
          toStringArray(result.output.key_learnings),
          "reported",
        ),
        shouldFullyStop,
      };
    } catch (err) {
      const elapsedMs = Date.now() - agentStartedAt;
      if (this.activeIterationTokensEstimated) {
        this.state.tokensEstimated = true;
        this.activeIterationTokensEstimated = false;
      }

      if (
        this.pendingAbortReason &&
        err instanceof Error &&
        err.message === "Agent was aborted"
      ) {
        appendDebugLog("agent:run:aborted", {
          iteration: this.state.currentIteration,
          elapsedMs,
          reason: this.pendingAbortReason,
        });
        if (this.pendingCommitFailure === null) {
          resetHard(this.cwd);
        }
        return { type: "aborted", reason: this.pendingAbortReason };
      }

      if (this.stopRequested) {
        appendDebugLog("agent:run:stopped", {
          iteration: this.state.currentIteration,
          elapsedMs,
        });
        return { type: "stopped" };
      }

      // This is where diagnostics most often matter — particularly for
      // `TypeError: fetch failed`, where the surface message is useless
      // without the undici cause chain. Always serialize the full error
      // before we collapse it to a string for the notes file.
      appendDebugLog("agent:run:error", {
        iteration: this.state.currentIteration,
        elapsedMs,
        error: serializeError(err),
      });

      if (err instanceof RateLimitAgentError) {
        if (this.pendingCommitFailure === null) {
          resetHard(this.cwd);
        }
        this.state.lastAgentError = err.message;
        return {
          type: "rate-limited",
          resumeAt: err.resumeAt,
          message: err.message,
        };
      }

      if (err instanceof PermanentAgentError) {
        if (this.pendingCommitFailure === null) {
          resetHard(this.cwd);
        }
        this.state.lastAgentError = err.detail;
        return { type: "aborted", reason: err.message };
      }

      const summary = err instanceof Error ? err.message : String(err);
      return {
        type: "completed",
        record: this.recordFailure(`[ERROR] ${summary}`, summary, [], "error"),
        shouldFullyStop: false,
      };
    } finally {
      this.activeAbortController = null;
      this.pendingAbortReason = null;
    }
  }

  private recordSuccess(output: AgentOutput): IterationRecord {
    const keyChanges = toStringArray(output.key_changes_made);
    const keyLearnings = toStringArray(output.key_learnings);
    try {
      commitAll(
        buildCommitMessage(this.config.commitMessage, output, {
          iteration: this.state.currentIteration,
        }),
        this.cwd,
      );
    } catch (error) {
      if (error instanceof CommitFailedError) {
        return this.recordCommitFailure(error);
      }
      throw error;
    }

    this.pendingCommitFailure = null;
    appendNotes(
      this.runInfo.notesPath,
      this.state.currentIteration,
      output.summary,
      keyChanges,
      keyLearnings,
    );
    this.state.commitCount = getBranchCommitCount(
      this.runInfo.baseCommit,
      this.cwd,
    );
    this.state.successCount++;
    this.state.consecutiveFailures = 0;
    this.state.consecutiveErrors = 0;
    this.state.lastAgentError = null;
    return {
      number: this.state.currentIteration,
      success: true,
      summary: output.summary,
      keyChanges,
      keyLearnings,
      timestamp: new Date(),
    };
  }

  private buildCommitRepairPrompt(basePrompt: string): string {
    return `${basePrompt}

## Previous Commit Failure

The previous iteration made workspace changes, but gnhf could not commit them because git commit failed.
Do not start unrelated work.
Inspect and fix the existing uncommitted changes so the commit can pass, then report success.

Git commit output:

\`\`\`
${this.pendingCommitFailure}
\`\`\``;
  }

  private recordCommitFailure(error: CommitFailedError): IterationRecord {
    this.pendingCommitFailure = error.detail;
    const summary = "git commit failed; asking agent to repair the workspace";
    appendNotes(
      this.runInfo.notesPath,
      this.state.currentIteration,
      `[ERROR] ${summary}`,
      [],
      [error.detail],
    );
    this.state.failCount++;
    this.state.consecutiveFailures++;
    this.state.consecutiveErrors = 0;
    this.state.lastAgentError = error.detail;
    return {
      number: this.state.currentIteration,
      success: false,
      summary,
      keyChanges: [],
      keyLearnings: [error.detail],
      timestamp: new Date(),
    };
  }

  private pushAfterSuccess(): string | undefined {
    try {
      pushCurrentBranch(this.cwd);
      appendDebugLog("git:push:success", {
        iteration: this.state.currentIteration,
      });
      return undefined;
    } catch (err) {
      appendDebugLog("git:push:error", {
        iteration: this.state.currentIteration,
        error: serializeError(err),
      });
      const message = err instanceof Error ? err.message : String(err);
      return `push failed: ${message}`;
    }
  }

  private recordFailure(
    notesSummary: string,
    recordSummary: string,
    learnings: string[],
    kind: "reported" | "error",
  ): IterationRecord {
    const hadPendingCommitFailure = this.pendingCommitFailure !== null;
    appendNotes(
      this.runInfo.notesPath,
      this.state.currentIteration,
      notesSummary,
      [],
      toStringArray(learnings),
    );
    if (!hadPendingCommitFailure) {
      resetHard(this.cwd);
    }
    this.state.failCount++;
    this.state.consecutiveFailures++;
    // Only hard errors (agent threw) escalate the backoff streak. Explicit
    // agent-reported failures indicate the loop is healthy - the agent tried
    // and concluded it couldn't succeed - so we move straight to the next
    // iteration.
    if (kind === "error") {
      this.state.consecutiveErrors++;
      this.state.lastAgentError = recordSummary;
    } else {
      this.state.consecutiveErrors = 0;
      this.state.lastAgentError = null;
    }
    return {
      number: this.state.currentIteration,
      success: false,
      summary: recordSummary,
      keyChanges: [],
      keyLearnings: toStringArray(learnings),
      timestamp: new Date(),
    };
  }

  // Shared pause for both ways a usage window ends. A rejection produced no
  // work, so its attempt is rolled back and retried under the same iteration
  // number. An iteration billed to extra usage already committed real work, so
  // it keeps its number and only the next one waits. On a rejection the
  // standing `lastAgentError` is the provider's own account of the wait, worth
  // keeping if the leash aborts; on the overage path it is an unrelated
  // leftover, so `clearAgentErrorOnAbort` stops it displacing the abort reason.
  // Returns "stop" when the run must end, either because the wait budget is
  // spent or a stop arrived.
  private async waitForUsageWindowReset(options: {
    waitMs: number;
    resumeAt: Date | null;
    logPrefix: string;
    message: string;
    rollBackIteration: boolean;
    clearAgentErrorOnAbort: boolean;
  }): Promise<"resume" | "stop"> {
    const {
      waitMs,
      resumeAt,
      logPrefix,
      message,
      rollBackIteration,
      clearAgentErrorOnAbort,
    } = options;
    const nextTotalWaitMs = this.totalRateLimitWaitMs + waitMs;
    const maxRateLimitWaitMs = this.limits.maxRateLimitWaitMs;
    if (
      maxRateLimitWaitMs !== undefined &&
      nextTotalWaitMs > maxRateLimitWaitMs
    ) {
      appendDebugLog(`${logPrefix}:wait:aborted`, {
        iteration: this.state.currentIteration,
        message,
        resumeAt: resumeAt?.toISOString() ?? null,
        waitMs,
        totalWaitMs: this.totalRateLimitWaitMs,
        maxRateLimitWaitMs,
      });
      if (clearAgentErrorOnAbort) {
        this.state.lastAgentError = null;
      }
      this.abort(
        `maximum rate-limit wait exceeded (${nextTotalWaitMs}ms > ${maxRateLimitWaitMs}ms)`,
      );
      return "stop";
    }
    this.totalRateLimitWaitMs = nextTotalWaitMs;
    if (rollBackIteration) {
      this.state.currentIteration--;
    }
    if (this.stopForGracefulShutdown()) {
      return "stop";
    }
    const logIteration =
      this.state.currentIteration + (rollBackIteration ? 1 : 0);
    // Naming the pause is what tells an overage wait apart from an error
    // backoff in the TUI, but it is a status notice, not an error: it is
    // restored once the pause ends so it can never be reported as the reason
    // the run finished.
    const agentErrorBeforeWait = this.state.lastAgentError ?? null;
    this.state.status = "waiting";
    this.state.waitingUntil = new Date(Date.now() + waitMs);
    this.state.lastAgentError = message;
    this.emit("state", this.getState());

    appendDebugLog(`${logPrefix}:wait:start`, {
      iteration: logIteration,
      message,
      resumeAt: resumeAt?.toISOString() ?? null,
      waitMs,
      consecutiveRateLimitWaits: this.consecutiveRateLimitWaits,
    });

    try {
      await this.interruptibleSleep(waitMs);
    } finally {
      this.state.lastAgentError = agentErrorBeforeWait;
    }

    appendDebugLog(`${logPrefix}:wait:end`, {
      iteration: logIteration,
      stopRequested: this.stopRequested,
    });

    this.state.waitingUntil = null;
    if (this.stopRequested) {
      return "stop";
    }
    if (this.stopForGracefulShutdown()) {
      return "stop";
    }
    this.state.status = "running";
    this.emit("state", this.getState());
    return "resume";
  }

  // The single owner of what a provider-reported reset time is worth. "none"
  // is no reset time at all; "elapsed" is the provider's own instant saying the
  // window has already come back, tested against that instant directly rather
  // than inferred from the wait constants; "wait" carries the sleep to take,
  // with `truncated` set when the cap ends it short of the reset. Each variant
  // carries the instant it describes, so callers never re-derive any of this.
  private providerResumeWait(resumeAt: Date | null): ProviderResumeWait {
    if (!resumeAt) return { kind: "none" };
    if (resumeAt.getTime() <= Date.now()) return { kind: "elapsed", resumeAt };
    const waitMs =
      resumeAt.getTime() + RATE_LIMIT_RESUME_BUFFER_MS - Date.now();
    return waitMs > RATE_LIMIT_MAX_WAIT_MS
      ? {
          kind: "wait",
          resumeAt,
          waitMs: RATE_LIMIT_MAX_WAIT_MS,
          truncated: true,
        }
      : { kind: "wait", resumeAt, waitMs, truncated: false };
  }

  private fallbackResumeWaitMs(): number {
    return Math.min(
      RATE_LIMIT_MIN_WAIT_MS *
        Math.pow(2, Math.max(0, this.consecutiveRateLimitWaits - 1)),
      RATE_LIMIT_MAX_FALLBACK_WAIT_MS,
    );
  }

  private interruptibleSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.activeAbortController = new AbortController();
      const timer = setTimeout(() => {
        this.activeAbortController = null;
        resolve();
      }, ms);

      this.activeAbortController.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        this.activeAbortController = null;
        resolve();
      });
    });
  }

  private getPreIterationAbortReason(): string | null {
    if (
      this.limits.maxIterations !== undefined &&
      this.state.currentIteration >= this.limits.maxIterations
    ) {
      return `max iterations reached (${this.limits.maxIterations})`;
    }

    return this.getTokenAbortReason();
  }

  private getPostIterationAbortReason(): string | null {
    if (
      this.limits.maxIterations !== undefined &&
      this.state.currentIteration >= this.limits.maxIterations
    ) {
      return `max iterations reached (${this.limits.maxIterations})`;
    }

    return this.getTokenAbortReason();
  }

  private getTokenAbortReason(): string | null {
    if (this.limits.maxTokens === undefined) return null;

    const totalTokens = getTotalTokenCount(
      this.state.totalInputTokens,
      this.state.totalOutputTokens,
      this.state.totalCacheReadTokens,
      this.state.totalCacheCreationTokens,
    );
    if (totalTokens < this.limits.maxTokens) return null;

    return `max tokens reached (${totalTokens}/${this.limits.maxTokens})`;
  }

  private finishGracefulStop(): void {
    this.state.status = "stopped";
    this.state.gracefulStopRequested = false;
    this.state.waitingUntil = null;
    appendDebugLog("orchestrator:graceful-stop-complete", {
      iteration: this.state.currentIteration,
      consecutiveFailures: this.state.consecutiveFailures,
    });
    this.emit("state", this.getState());
  }

  private stopForGracefulShutdown(): boolean {
    if (!this.state.gracefulStopRequested) {
      return false;
    }
    this.finishGracefulStop();
    return true;
  }

  private didStopWithoutForce(): boolean {
    return this.stopPromise === null && this.state.status === "stopped";
  }

  private abort(reason: string): void {
    this.state.status = "aborted";
    this.state.gracefulStopRequested = false;
    this.state.lastMessage = reason;
    this.state.waitingUntil = null;
    appendDebugLog("orchestrator:abort", {
      reason,
      iteration: this.state.currentIteration,
      consecutiveFailures: this.state.consecutiveFailures,
    });
    this.emit("abort", reason);
    this.emit("state", this.getState());
  }

  private async closeAgent(): Promise<void> {
    try {
      await this.agent.close?.();
    } catch (err) {
      appendDebugLog("agent:close:error", {
        error: serializeError(err),
      });
      // Best-effort cleanup only.
    }
  }

  private emitStopped(): void {
    if (this.stoppedEventEmitted) {
      return;
    }
    this.stoppedEventEmitted = true;
    this.emit("stopped");
  }

  private snapshotGitState(): Record<string, unknown> {
    // Cheap diagnostic snapshot — catches "previous iteration's reset
    // didn't land" and "we're on the wrong branch" bugs that otherwise
    // look identical to real agent failures.
    try {
      return {
        head: getHeadCommit(this.cwd),
        branch: getCurrentBranch(this.cwd),
        commitCount: this.state.commitCount,
      };
    } catch (err) {
      return {
        error: serializeError(err),
      };
    }
  }
}
