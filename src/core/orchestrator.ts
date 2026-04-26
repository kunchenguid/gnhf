import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { Agent, AgentOutput, TokenUsage } from "./agents/types.js";
import type { Config } from "./config.js";
import type { RunInfo } from "./run.js";
import { appendNotes, toStringArray } from "./run.js";
import { appendDebugLog, serializeError } from "./debug-log.js";
import {
  commitAll,
  getBranchCommitCount,
  getCurrentBranch,
  getHeadCommit,
  resetHard,
} from "./git.js";
import { buildIterationPrompt } from "../templates/iteration-prompt.js";

export interface IterationRecord {
  number: number;
  success: boolean;
  summary: string;
  keyChanges: string[];
  keyLearnings: string[];
  timestamp: Date;
}

export interface OrchestratorState {
  status: "running" | "waiting" | "aborted" | "stopped";
  currentIteration: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  commitCount: number;
  iterations: IterationRecord[];
  successCount: number;
  failCount: number;
  consecutiveFailures: number;
  consecutiveErrors: number;
  startTime: Date;
  waitingUntil: Date | null;
  lastMessage: string | null;
}

export interface OrchestratorEvents {
  state: [OrchestratorState];
  "iteration:start": [number];
  "iteration:end": [IterationRecord];
  abort: [string];
  stopped: [];
}

export interface RunLimits {
  maxIterations?: number;
  maxTokens?: number;
  stopWhen?: string;
}

const STOP_CLOSE_AGENT_GRACE_MS = 250;

type RunIterationResult =
  | { type: "completed"; record: IterationRecord; shouldFullyStop: boolean }
  | { type: "stopped" }
  | { type: "aborted"; reason: string };

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
  private loopDone = false;

  private state: OrchestratorState = {
    status: "running",
    currentIteration: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    commitCount: 0,
    iterations: [],
    successCount: 0,
    failCount: 0,
    consecutiveFailures: 0,
    consecutiveErrors: 0,
    startTime: new Date(),
    waitingUntil: null,
    lastMessage: null,
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
    this.limits = limits;
    this.state.currentIteration = startIteration;
    this.state.commitCount = getBranchCommitCount(
      this.runInfo.baseCommit,
      this.cwd,
    );
  }

  getState(): OrchestratorState {
    return { ...this.state };
  }

  stop(): void {
    this.stopRequested = true;
    appendDebugLog("orchestrator:stop-requested", {
      iteration: this.state.currentIteration,
      hasActiveIteration: this.activeIterationPromise !== null,
      loopDone: this.loopDone,
    });
    this.activeAbortController?.abort();

    if (this.loopDone) {
      this.emit("stopped");
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
      this.state.status = "stopped";
      this.emit("state", this.getState());
      this.emit("stopped");
    })();
  }

  async start(): Promise<void> {
    this.state.startTime = new Date();
    this.state.status = "running";
    this.emit("state", this.getState());

    appendDebugLog("orchestrator:start", {
      agent: this.agent.name,
      runId: this.runInfo.runId,
      startIteration: this.state.currentIteration,
      maxIterations: this.limits.maxIterations,
      maxTokens: this.limits.maxTokens,
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

        this.state.currentIteration++;
        this.state.status = "running";
        this.emit("iteration:start", this.state.currentIteration);
        this.emit("state", this.getState());

        const iterationPrompt = buildIterationPrompt({
          n: this.state.currentIteration,
          runId: this.runInfo.runId,
          prompt: this.prompt,
          stopWhen: this.limits.stopWhen,
        });

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
          commitCount: this.state.commitCount,
        });

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

    this.activeAbortController = new AbortController();
    this.pendingAbortReason = null;

    const onUsage = (usage: TokenUsage) => {
      this.state.totalInputTokens = baseInputTokens + usage.inputTokens;
      this.state.totalOutputTokens = baseOutputTokens + usage.outputTokens;
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

    const logPath = join(
      this.runInfo.runDir,
      `iteration-${this.state.currentIteration}.jsonl`,
    );

    const agentStartedAt = Date.now();
    appendDebugLog("agent:run:start", {
      iteration: this.state.currentIteration,
      agent: this.agent.name,
      logPath,
    });

    try {
      const result = await this.agent.run(prompt, this.cwd, {
        onUsage,
        onMessage,
        signal: this.activeAbortController.signal,
        logPath,
      });

      appendDebugLog("agent:run:end", {
        iteration: this.state.currentIteration,
        elapsedMs: Date.now() - agentStartedAt,
        success: result.output.success,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        cacheCreationTokens: result.usage.cacheCreationTokens,
      });

      if (this.stopRequested) {
        return { type: "stopped" };
      }

      const shouldFullyStop = result.output.should_fully_stop === true;

      if (result.output.success) {
        return {
          type: "completed",
          record: this.recordSuccess(result.output),
          shouldFullyStop,
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
        resetHard(this.cwd);
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
    appendNotes(
      this.runInfo.notesPath,
      this.state.currentIteration,
      output.summary,
      toStringArray(output.key_changes_made),
      toStringArray(output.key_learnings),
    );
    commitAll(
      `gnhf #${this.state.currentIteration}: ${output.summary}`,
      this.cwd,
    );
    this.state.commitCount = getBranchCommitCount(
      this.runInfo.baseCommit,
      this.cwd,
    );
    this.state.successCount++;
    this.state.consecutiveFailures = 0;
    this.state.consecutiveErrors = 0;
    return {
      number: this.state.currentIteration,
      success: true,
      summary: output.summary,
      keyChanges: toStringArray(output.key_changes_made),
      keyLearnings: toStringArray(output.key_learnings),
      timestamp: new Date(),
    };
  }

  private recordFailure(
    notesSummary: string,
    recordSummary: string,
    learnings: string[],
    kind: "reported" | "error",
  ): IterationRecord {
    appendNotes(
      this.runInfo.notesPath,
      this.state.currentIteration,
      notesSummary,
      [],
      toStringArray(learnings),
    );
    resetHard(this.cwd);
    this.state.failCount++;
    this.state.consecutiveFailures++;
    // Only hard errors (agent threw) escalate the backoff streak. Explicit
    // agent-reported failures indicate the loop is healthy - the agent tried
    // and concluded it couldn't succeed - so we move straight to the next
    // iteration.
    if (kind === "error") {
      this.state.consecutiveErrors++;
    } else {
      this.state.consecutiveErrors = 0;
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

    const totalTokens =
      this.state.totalInputTokens + this.state.totalOutputTokens;
    if (totalTokens < this.limits.maxTokens) return null;

    return `max tokens reached (${totalTokens}/${this.limits.maxTokens})`;
  }

  private abort(reason: string): void {
    this.state.status = "aborted";
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
