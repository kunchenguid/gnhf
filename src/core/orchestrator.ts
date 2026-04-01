import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { Agent, AgentOutput, TokenUsage } from "./agents/types.js";
import type { Config } from "./config.js";
import type { RunInfo } from "./run.js";
import { commitAll, getBranchCommitCount, resetHard } from "./git.js";
import { appendNotes } from "./run.js";
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

export class Orchestrator extends EventEmitter<OrchestratorEvents> {
  private config: Config;
  private agent: Agent;
  private runInfo: RunInfo;
  private cwd: string;
  private prompt: string;
  private stopRequested = false;
  private activeAbortController: AbortController | null = null;

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
  ) {
    super();
    this.config = config;
    this.agent = agent;
    this.runInfo = runInfo;
    this.prompt = prompt;
    this.cwd = cwd;
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
    this.activeAbortController?.abort();
    resetHard(this.cwd);
    this.state.status = "stopped";
    this.emit("state", this.getState());
    this.emit("stopped");
  }

  async start(): Promise<void> {
    this.state.startTime = new Date();
    this.state.status = "running";
    this.emit("state", this.getState());

    while (!this.stopRequested) {
      this.state.currentIteration++;
      this.state.status = "running";
      this.emit("iteration:start", this.state.currentIteration);
      this.emit("state", this.getState());

      const iterationPrompt = buildIterationPrompt({
        n: this.state.currentIteration,
        runId: this.runInfo.runId,
        prompt: this.prompt,
      });

      const record = await this.runIteration(iterationPrompt);

      this.state.iterations.push(record);
      this.emit("iteration:end", record);
      this.emit("state", this.getState());

      if (
        this.state.consecutiveFailures >= this.config.maxConsecutiveFailures
      ) {
        this.state.status = "aborted";
        const reason = `${this.config.maxConsecutiveFailures} consecutive failures`;
        this.emit("abort", reason);
        this.emit("state", this.getState());
        break;
      }

      if (this.state.consecutiveFailures > 0 && !this.stopRequested) {
        const backoffMs =
          60_000 * Math.pow(2, this.state.consecutiveFailures - 1);
        this.state.status = "waiting";
        this.state.waitingUntil = new Date(Date.now() + backoffMs);
        this.emit("state", this.getState());

        await this.interruptibleSleep(backoffMs);

        this.state.waitingUntil = null;
        if (!this.stopRequested) {
          this.state.status = "running";
          this.emit("state", this.getState());
        }
      }
    }
  }

  private async runIteration(prompt: string): Promise<IterationRecord> {
    const baseInputTokens = this.state.totalInputTokens;
    const baseOutputTokens = this.state.totalOutputTokens;

    this.activeAbortController = new AbortController();

    const onUsage = (usage: TokenUsage) => {
      this.state.totalInputTokens = baseInputTokens + usage.inputTokens;
      this.state.totalOutputTokens = baseOutputTokens + usage.outputTokens;
      this.emit("state", this.getState());
    };

    const onMessage = (text: string) => {
      this.state.lastMessage = text;
      this.emit("state", this.getState());
    };

    const logPath = join(
      this.runInfo.runDir,
      `iteration-${this.state.currentIteration}.jsonl`,
    );

    try {
      const result = await this.agent.run(prompt, this.cwd, {
        onUsage,
        onMessage,
        signal: this.activeAbortController.signal,
        logPath,
      });

      if (result.output.success) {
        return this.recordSuccess(result.output);
      }
      return this.recordFailure(
        `[FAIL] ${result.output.summary}`,
        result.output.summary,
        result.output.key_learnings,
      );
    } catch (err) {
      const summary = err instanceof Error ? err.message : String(err);
      return this.recordFailure(`[ERROR] ${summary}`, summary, []);
    }
  }

  private recordSuccess(output: AgentOutput): IterationRecord {
    appendNotes(
      this.runInfo.notesPath,
      this.state.currentIteration,
      output.summary,
      output.key_changes_made,
      output.key_learnings,
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
    return {
      number: this.state.currentIteration,
      success: true,
      summary: output.summary,
      keyChanges: output.key_changes_made,
      keyLearnings: output.key_learnings,
      timestamp: new Date(),
    };
  }

  private recordFailure(
    notesSummary: string,
    recordSummary: string,
    learnings: string[],
  ): IterationRecord {
    appendNotes(
      this.runInfo.notesPath,
      this.state.currentIteration,
      notesSummary,
      [],
      learnings,
    );
    resetHard(this.cwd);
    this.state.failCount++;
    this.state.consecutiveFailures++;
    return {
      number: this.state.currentIteration,
      success: false,
      summary: recordSummary,
      keyChanges: [],
      keyLearnings: learnings,
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
}
