import {
  type Agent,
  type AgentResult,
  type AgentRunOptions,
  type AsyncAgent,
  type AsyncAgentSession,
  type AsyncAgentPollResult,
} from "./types.js";

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

const POLLABLE_STATES = new Set([
  "queued",
  "planning",
  "awaiting_plan_approval",
  "in_progress",
]);

export interface AsyncAgentAdapterOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  onStatusChange?: (status: AsyncAgentPollResult) => void;
}

export class AsyncAgentAdapter implements Agent {
  name: string;

  constructor(
    private asyncAgent: AsyncAgent,
    private options: AsyncAgentAdapterOptions = {},
  ) {
    this.name = asyncAgent.name;
  }

  async run(
    prompt: string,
    cwd: string,
    options?: AgentRunOptions,
  ): Promise<AgentResult> {
    const pollIntervalMs =
      this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startTime = Date.now();

    try {
      const session = await Promise.race([
        this.asyncAgent.submit(prompt, cwd),
        waitForAbort(options?.signal),
      ]);

      process.stderr.write(
        `\n[${this.name}] Session started: ${session.url}\n`,
      );
      process.stderr.write(`[${this.name}] Monitor at: ${session.url}\n\n`);

      return await this.pollUntilDone(
        session,
        pollIntervalMs,
        timeoutMs,
        startTime,
        options,
      );
    } finally {
      if (this.asyncAgent.close) {
        await this.asyncAgent.close();
      }
    }
  }

  private async pollUntilDone(
    session: AsyncAgentSession,
    pollIntervalMs: number,
    timeoutMs: number,
    startTime: number,
    runOptions?: AgentRunOptions,
  ): Promise<AgentResult> {
    while (true) {
      if (Date.now() - startTime > timeoutMs) {
        throw new Error(
          `${this.name} session ${session.id} timed out after ${timeoutMs / 1000 / 60} minutes`,
        );
      }

      if (runOptions?.signal?.aborted) {
        throw new Error("Agent was aborted");
      }

      const pollResult = await this.asyncAgent.poll(session);

      this.options.onStatusChange?.(pollResult);

      if (pollResult.status === "completed") {
        return this.buildResult(session, pollResult);
      }

      if (pollResult.status === "failed") {
        throw new Error(
          `${this.name} session failed: ${pollResult.reason ?? "Unknown reason"}`,
        );
      }

      if (!POLLABLE_STATES.has(pollResult.status)) {
        throw new Error(
          `${this.name} session entered unexpected state: ${pollResult.status}`,
        );
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      process.stderr.write(
        `[${this.name}] Session ${session.id} — ${pollResult.status} (${elapsed}s elapsed)\n`,
      );

      await sleep(pollIntervalMs, runOptions?.signal);
    }
  }

  private buildResult(
    session: AsyncAgentSession,
    pollResult: AsyncAgentPollResult,
  ): AgentResult {
    return {
      output: {
        success: true,
        summary:
          pollResult.summary ??
          `${this.name} completed session ${session.id}${pollResult.pullRequestUrl ? ` — PR: ${pollResult.pullRequestUrl}` : ""}`,
        key_changes_made: pollResult.keyChangesMade ?? [],
        key_learnings: pollResult.keyLearnings ?? [],
      },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    };
  }

  async close(): Promise<void> {
    if (this.asyncAgent.close) {
      await this.asyncAgent.close();
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return Promise.race([
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
    waitForAbort(signal),
  ]);
}

function waitForAbort(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(new Error("Agent was aborted"));
      return;
    }
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error("Agent was aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
