import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./git.js", () => ({
  commitAll: vi.fn(),
  getBranchCommitCount: vi.fn(() => 0),
  getCurrentBranch: vi.fn(() => "gnhf/run-abc"),
  getHeadCommit: vi.fn(() => "head123"),
  resetHard: vi.fn(),
}));

vi.mock("./run.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./run.js")>();
  return {
    ...actual,
    appendNotes: vi.fn(),
  };
});

vi.mock("./debug-log.js", () => ({
  appendDebugLog: vi.fn(),
  initDebugLog: vi.fn(),
  serializeError: vi.fn((err: unknown) =>
    err instanceof Error
      ? { name: err.name, message: err.message }
      : { value: String(err) },
  ),
}));

vi.mock("../templates/iteration-prompt.js", () => ({
  buildIterationPrompt: vi.fn(() => "iteration prompt"),
}));

import { commitAll, resetHard } from "./git.js";
import { appendNotes } from "./run.js";
import { Orchestrator } from "./orchestrator.js";
import type { Agent, AgentResult } from "./agents/types.js";
import type { Config } from "./config.js";
import type { RunInfo } from "./run.js";

const mockCommitAll = vi.mocked(commitAll);
const mockAppendNotes = vi.mocked(appendNotes);
const mockResetHard = vi.mocked(resetHard);

const config: Config = {
  agent: "claude",
  agentPathOverride: {},
  agentArgsOverride: {},
  maxConsecutiveFailures: 3,
  preventSleep: true,
};

const runInfo: RunInfo = {
  runId: "run-abc",
  runDir: "/repo/.gnhf/runs/run-abc",
  promptPath: "/repo/.gnhf/runs/run-abc/prompt.md",
  notesPath: "/repo/.gnhf/runs/run-abc/notes.md",
  schemaPath: "/repo/.gnhf/runs/run-abc/output-schema.json",
  logPath: "/repo/.gnhf/runs/run-abc/gnhf.log",
  baseCommit: "base123",
  baseCommitPath: "/repo/.gnhf/runs/run-abc/base-commit",
};

function createSuccessResult(summary = "done"): AgentResult {
  return {
    output: {
      success: true,
      summary,
      key_changes_made: ["file.ts"],
      key_learnings: ["learning"],
    },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
  };
}

describe("Orchestrator output normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("handles key_changes_made returned as a JSON string instead of an array", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(
        async () =>
          ({
            output: {
              success: true,
              summary: "done",
              key_changes_made: '["file.ts", "other.ts"]',
              key_learnings: ["learning"],
            },
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
            },
          }) as unknown as AgentResult,
      ),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 1 },
    );

    await orchestrator.start();

    expect(mockAppendNotes).toHaveBeenCalledTimes(1);
    expect(mockAppendNotes).toHaveBeenCalledWith(
      runInfo.notesPath,
      1,
      "done",
      ["file.ts", "other.ts"],
      ["learning"],
    );
    expect(mockCommitAll).toHaveBeenCalledTimes(1);
    expect(orchestrator.getState().status).toBe("aborted");
  });

  it("handles key_learnings returned as a JSON string instead of an array", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(
        async () =>
          ({
            output: {
              success: true,
              summary: "done",
              key_changes_made: ["file.ts"],
              key_learnings: '["first lesson", "second lesson"]',
            },
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
            },
          }) as unknown as AgentResult,
      ),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 1 },
    );

    await orchestrator.start();

    expect(mockAppendNotes).toHaveBeenCalledTimes(1);
    expect(mockAppendNotes).toHaveBeenCalledWith(
      runInfo.notesPath,
      1,
      "done",
      ["file.ts"],
      ["first lesson", "second lesson"],
    );
    expect(mockCommitAll).toHaveBeenCalledTimes(1);
    expect(orchestrator.getState().status).toBe("aborted");
  });

  it("falls back to single-element array when key_changes_made is a non-JSON string", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(
        async () =>
          ({
            output: {
              success: true,
              summary: "done",
              key_changes_made: "malformed output",
              key_learnings: [],
            },
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
            },
          }) as unknown as AgentResult,
      ),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 1 },
    );

    await orchestrator.start();

    expect(mockAppendNotes).toHaveBeenCalledTimes(1);
    expect(mockAppendNotes).toHaveBeenCalledWith(
      runInfo.notesPath,
      1,
      "done",
      ["malformed output"],
      [],
    );
    expect(mockCommitAll).toHaveBeenCalledTimes(1);
    expect(orchestrator.getState().status).toBe("aborted");
  });
});

describe("Orchestrator stop limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("aborts before starting when the max iteration cap is already reached", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      2,
      { maxIterations: 2 },
    );

    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await orchestrator.start();

    expect(agent.run).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledWith("max iterations reached (2)");
    expect(orchestrator.getState().status).toBe("aborted");
  });

  it("aborts after completing the configured number of iterations", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => createSuccessResult()),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 1 },
    );

    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await orchestrator.start();

    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(mockCommitAll).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith("max iterations reached (1)");
    expect(orchestrator.getState().status).toBe("aborted");
  });

  it("aborts after the iteration when the agent reports should_fully_stop and stopWhen is set", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => ({
        output: {
          success: true,
          summary: "all tasks done",
          key_changes_made: ["file.ts"],
          key_learnings: [],
          should_fully_stop: true,
        },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      })),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { stopWhen: "all tasks done", maxIterations: 5 },
    );

    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await orchestrator.start();

    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(mockCommitAll).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith("stop condition met");
    expect(orchestrator.getState().status).toBe("aborted");
  });

  it("aborts when the agent reports should_fully_stop with success=false and stopWhen is set", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => ({
        output: {
          success: false,
          summary: "nothing left to do",
          key_changes_made: [],
          key_learnings: [],
          should_fully_stop: true,
        },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      })),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { stopWhen: "all tasks done", maxIterations: 5 },
    );

    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await orchestrator.start();

    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(mockCommitAll).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledWith("stop condition met");
    expect(orchestrator.getState().status).toBe("aborted");
  });

  it("ignores should_fully_stop when stopWhen is not set", async () => {
    let callCount = 0;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => {
        callCount++;
        return {
          output: {
            success: true,
            summary: `iter ${callCount}`,
            key_changes_made: [],
            key_learnings: [],
            should_fully_stop: true,
          },
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        };
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 2 },
    );

    await orchestrator.start();

    expect(agent.run).toHaveBeenCalledTimes(2);
    expect(orchestrator.getState().status).toBe("aborted");
  });

  it("aborts when reported token usage reaches the configured cap", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(
        (_prompt, _cwd, options) =>
          new Promise<AgentResult>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => {
              reject(new Error("Agent was aborted"));
            });
            options?.onUsage?.({
              inputTokens: 7,
              outputTokens: 4,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
            });
          }),
      ),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxTokens: 10 },
    );

    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await orchestrator.start();

    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(mockAppendNotes).not.toHaveBeenCalled();
    expect(mockCommitAll).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledWith("max tokens reached (11/10)");
    expect(orchestrator.getState()).toMatchObject({
      status: "aborted",
      totalInputTokens: 7,
      totalOutputTokens: 4,
    });
  });

  it("closes the agent when stop is requested", async () => {
    const close = vi.fn();
    const agent: Agent = {
      name: "claude",
      run: vi.fn(),
      close,
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
    );

    orchestrator.stop();
    await Promise.resolve();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("emits stopped only after agent cleanup completes", async () => {
    let resolveClose!: () => void;
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve;
        }),
    );
    const agent: Agent = {
      name: "claude",
      run: vi.fn(),
      close,
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
    );

    const stopped = vi.fn();
    orchestrator.on("stopped", stopped);

    orchestrator.stop();
    await Promise.resolve();

    expect(close).toHaveBeenCalledTimes(1);
    expect(stopped).not.toHaveBeenCalled();

    resolveClose();
    await Promise.resolve();
    await Promise.resolve();

    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it("waits for the active iteration to unwind before closing the agent", async () => {
    let rejectRun!: (error: Error) => void;
    const close = vi.fn(() => Promise.resolve());
    const agent: Agent = {
      name: "claude",
      run: vi.fn(
        (_prompt, _cwd, options) =>
          new Promise<AgentResult>((_resolve, reject) => {
            rejectRun = reject;
            options?.signal?.addEventListener("abort", () => {
              queueMicrotask(() => {
                reject(new Error("Agent was aborted"));
              });
            });
          }),
      ),
      close,
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
    );

    const startPromise = orchestrator.start();

    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(1);
    });

    orchestrator.stop();

    expect(close).not.toHaveBeenCalled();

    rejectRun(new Error("Agent was aborted"));
    await startPromise;

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("starts agent cleanup if a stopped iteration remains stuck after a grace period", async () => {
    vi.useFakeTimers();

    let rejectRun!: (error: Error) => void;
    const close = vi.fn(() => {
      rejectRun(new Error("Agent was aborted"));
      return Promise.resolve();
    });
    const agent: Agent = {
      name: "claude",
      run: vi.fn(
        (_prompt, _cwd, options) =>
          new Promise<AgentResult>((_resolve, reject) => {
            rejectRun = reject;
            options?.signal?.addEventListener("abort", () => {
              // Simulate an agent that stays hung until close() tears down
              // its backing process.
            });
          }),
      ),
      close,
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
    );

    const startPromise = orchestrator.start();

    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(1);
    });

    orchestrator.stop();

    expect(close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);

    expect(close).toHaveBeenCalledTimes(1);

    await startPromise;
  });

  it("does not record or commit a late successful result after stop is requested", async () => {
    vi.useFakeTimers();

    let resolveRun!: (result: AgentResult) => void;
    const close = vi.fn(() => Promise.resolve());
    const agent: Agent = {
      name: "claude",
      run: vi.fn(
        (_prompt, _cwd, options) =>
          new Promise<AgentResult>((resolve) => {
            resolveRun = resolve;
            options?.signal?.addEventListener("abort", () => {
              setTimeout(() => {
                resolve(createSuccessResult("late success"));
              }, 10);
            });
          }),
      ),
      close,
    };
    const orchestrator = new Orchestrator(
      { ...config, preventSleep: false },
      agent,
      runInfo,
      "ship it",
      "/repo",
    );

    const startPromise = orchestrator.start();

    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(1);
    });

    orchestrator.stop();
    await vi.advanceTimersByTimeAsync(10);
    await startPromise;

    expect(resolveRun).toBeTypeOf("function");
    expect(mockAppendNotes).not.toHaveBeenCalled();
    expect(mockCommitAll).not.toHaveBeenCalled();
    expect(orchestrator.getState().iterations).toEqual([]);
    expect(orchestrator.getState().status).toBe("stopped");
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("Orchestrator backoff behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not back off after an explicit agent failure (success=false)", async () => {
    vi.useFakeTimers();

    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => ({
        output: {
          success: false,
          summary: "tried and failed",
          key_changes_made: [],
          key_learnings: [],
        },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      })),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 2 },
    );

    const startPromise = orchestrator.start();

    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(1);
    });

    // Without advancing any timers, iteration 2 must start.
    // If backoff were (incorrectly) triggered, a 60s timer would block us
    // and waitFor would time out.
    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(2);
    });

    await startPromise;

    expect(orchestrator.getState().status).toBe("aborted");
  });

  it("backs off after an error failure (agent threw)", async () => {
    vi.useFakeTimers();

    let callCount = 0;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error("transient error");
        }
        return createSuccessResult();
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 2 },
    );

    const startPromise = orchestrator.start();

    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(1);
    });

    // After the error, a backoff timer should be scheduled.
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBeGreaterThan(0);
    });
    // And iteration 2 must not have started yet.
    expect(agent.run).toHaveBeenCalledTimes(1);

    // Advance past the 60s first-failure backoff.
    await vi.advanceTimersByTimeAsync(60_000);

    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(2);
    });

    await startPromise;
  });

  it("resets the error streak after a reported failure so a later error backs off from 60s again", async () => {
    vi.useFakeTimers();

    let callCount = 0;
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error("early error");
        if (callCount === 2)
          return {
            output: {
              success: false,
              summary: "tried and failed",
              key_changes_made: [],
              key_learnings: [],
            },
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
            },
          };
        if (callCount === 3) throw new Error("later error");
        return createSuccessResult();
      }),
    };
    const orchestrator = new Orchestrator(
      { ...config, maxConsecutiveFailures: 10 },
      agent,
      runInfo,
      "ship it",
      "/repo",
      0,
      { maxIterations: 4 },
    );

    const startPromise = orchestrator.start();

    // Iteration 1: error -> backoff 60s
    await vi.waitFor(() => expect(agent.run).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(60_000);

    // Iteration 2 (reported failure) has no backoff so iteration 3 (error)
    // follows immediately; waiting for the third call verifies the no-backoff
    // path between 2 and 3.
    await vi.waitFor(() => expect(agent.run).toHaveBeenCalledTimes(3));

    // Wait for iteration 3's backoff to be scheduled before advancing time.
    await vi.waitFor(() =>
      expect(orchestrator.getState().status).toBe("waiting"),
    );

    // Iteration 3's error backoff should be 60s again (streak reset), not
    // 120s. Advancing exactly 60s must be enough to unblock iteration 4.
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(agent.run).toHaveBeenCalledTimes(4));

    await startPromise;
  });
});

describe("Orchestrator crash resilience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    mockResetHard.mockImplementation(() => {});
    mockAppendNotes.mockImplementation(() => {});
  });

  it("rethrows when git reset fails during failure recording", async () => {
    mockResetHard.mockImplementation(() => {
      throw new Error("not a git repository");
    });

    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => ({
        output: {
          success: false,
          summary: "iteration failed",
          key_changes_made: [],
          key_learnings: [],
        },
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      })),
    };

    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
    );

    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await expect(orchestrator.start()).rejects.toThrow("not a git repository");

    expect(orchestrator.getState().status).not.toBe("aborted");
    expect(abort).not.toHaveBeenCalled();
  });

  it("rethrows success recording failures without resetting the worktree", async () => {
    mockAppendNotes.mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });

    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => createSuccessResult()),
    };

    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
    );

    const abort = vi.fn();
    orchestrator.on("abort", abort);

    await expect(orchestrator.start()).rejects.toThrow(
      "ENOSPC: no space left on device",
    );

    expect(mockResetHard).not.toHaveBeenCalled();
    expect(orchestrator.getState().status).not.toBe("aborted");
    expect(abort).not.toHaveBeenCalled();
  });

  it("rethrows observer errors without resetting the worktree", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => createSuccessResult()),
    };

    const orchestrator = new Orchestrator(
      config,
      agent,
      runInfo,
      "ship it",
      "/repo",
    );

    orchestrator.on("iteration:end", () => {
      throw new Error("listener failed");
    });

    await expect(orchestrator.start()).rejects.toThrow("listener failed");

    expect(mockAppendNotes).toHaveBeenCalledTimes(1);
    expect(mockCommitAll).toHaveBeenCalledTimes(1);
    expect(mockResetHard).not.toHaveBeenCalled();
  });
});
