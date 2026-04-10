import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "./core/config.js";
import type { RunInfo } from "./core/run.js";

const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
).version as string;

const stubRunInfo: RunInfo = {
  runId: "run-abc",
  runDir: "/repo/.gnhf/runs/run-abc",
  promptPath: "/repo/.gnhf/runs/run-abc/PROMPT.md",
  notesPath: "/repo/.gnhf/runs/run-abc/notes.md",
  schemaPath: "/repo/.gnhf/runs/run-abc/schema.json",
  logPath: "/repo/.gnhf/runs/run-abc/gnhf.log",
  baseCommit: "abc123",
  baseCommitPath: "/repo/.gnhf/runs/run-abc/base-commit",
};

interface CliMockOverrides {
  appendDebugLog?: ReturnType<typeof vi.fn>;
  initDebugLog?: ReturnType<typeof vi.fn>;
  createAgent?: ReturnType<typeof vi.fn>;
  env?: Record<string, string | undefined>;
  getCurrentBranch?: ReturnType<typeof vi.fn>;
  getRepoRootDir?: ReturnType<typeof vi.fn>;
  createWorktree?: ReturnType<typeof vi.fn>;
  removeWorktree?: ReturnType<typeof vi.fn>;
  orchestratorStart?: ReturnType<typeof vi.fn>;
  orchestratorGetState?: ReturnType<typeof vi.fn>;
  readStdinText?: ReturnType<typeof vi.fn>;
  rendererWaitUntilExit?: ReturnType<typeof vi.fn>;
  rendererStop?: ReturnType<typeof vi.fn>;
  startSleepPrevention?: ReturnType<typeof vi.fn>;
  stdinIsTTY?: boolean;
}

async function runCliWithMocks(
  args: string[],
  config: Config,
  overrides: CliMockOverrides = {},
) {
  const originalArgv = [...process.argv];
  const stdoutWrite = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: string | number | null,
  ) => {
    throw new Error(
      `process.exit unexpectedly called with ${JSON.stringify(code)}`,
    );
  }) as typeof process.exit);

  const loadConfig = vi.fn(() => config);
  const createAgent =
    overrides.createAgent ?? vi.fn(() => ({ name: config.agent }));
  const appendDebugLog = overrides.appendDebugLog ?? vi.fn();
  const initDebugLog = overrides.initDebugLog ?? vi.fn();
  const readStdinText =
    overrides.readStdinText ?? vi.fn(() => Promise.resolve(""));
  const startSleepPrevention =
    overrides.startSleepPrevention ??
    vi.fn(() => Promise.resolve({ type: "skipped", reason: "unsupported" }));

  const orchestratorStart =
    overrides.orchestratorStart ?? vi.fn(() => Promise.resolve());
  const orchestratorStop = vi.fn();
  const orchestratorOn = vi.fn();
  const orchestratorGetState =
    overrides.orchestratorGetState ??
    vi.fn(() => ({
      status: "running" as const,
      currentIteration: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      commitCount: 0,
      iterations: [],
      successCount: 0,
      failCount: 0,
      consecutiveFailures: 0,
      startTime: new Date("2026-01-01T00:00:00Z"),
      waitingUntil: null,
      lastMessage: null,
    }));

  const rendererStart = vi.fn();
  const rendererStop = overrides.rendererStop ?? vi.fn();
  const rendererWaitUntilExit =
    overrides.rendererWaitUntilExit ?? vi.fn(() => Promise.resolve());
  const orchestratorCtor = vi.fn();

  vi.resetModules();
  vi.doMock("./core/config.js", () => ({ loadConfig }));
  vi.doMock("./core/debug-log.js", () => ({
    appendDebugLog,
    initDebugLog,
    serializeError: (err: unknown) =>
      err instanceof Error
        ? { name: err.name, message: err.message }
        : { value: String(err) },
  }));
  vi.doMock("./core/git.js", () => ({
    ensureCleanWorkingTree: vi.fn(),
    createBranch: vi.fn(),
    getHeadCommit: vi.fn(() => "abc123"),
    getCurrentBranch: overrides.getCurrentBranch ?? vi.fn(() => "main"),
    getRepoRootDir: overrides.getRepoRootDir ?? vi.fn(() => "/repo"),
    createWorktree: overrides.createWorktree ?? vi.fn(),
    removeWorktree: overrides.removeWorktree ?? vi.fn(),
  }));
  vi.doMock("./core/run.js", () => ({
    setupRun: vi.fn(() => stubRunInfo),
    resumeRun: vi.fn(),
    getLastIterationNumber: vi.fn(() => 0),
  }));
  vi.doMock("./core/stdin.js", () => ({ readStdinText }));
  vi.doMock("./core/agents/factory.js", () => ({ createAgent }));
  vi.doMock("./core/sleep.js", () => ({
    startSleepPrevention,
  }));
  vi.doMock("./core/orchestrator.js", () => ({
    Orchestrator: class MockOrchestrator {
      constructor(...args: unknown[]) {
        orchestratorCtor(...args);
      }
      start = orchestratorStart;
      stop = orchestratorStop;
      on = orchestratorOn;
      getState = orchestratorGetState;
    },
  }));
  vi.doMock("./renderer.js", () => ({
    Renderer: class MockRenderer {
      start = rendererStart;
      stop = rendererStop;
      waitUntilExit = rendererWaitUntilExit;
    },
  }));

  process.argv = ["node", "gnhf", ...args];
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: overrides.stdinIsTTY ?? true,
  });
  const envEntries = Object.entries(overrides.env ?? {});
  const originalEnv = new Map(
    envEntries.map(([key]) => [key, process.env[key]]),
  );
  for (const [key, value] of envEntries) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await import("./cli.js");
  } finally {
    process.argv = originalArgv;
    if (originalIsTTY) {
      Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
    }
    for (const [key, value] of originalEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    stdoutWrite.mockRestore();
    exitSpy.mockRestore();
  }

  return {
    appendDebugLog,
    loadConfig,
    createAgent,
    orchestratorCtor,
    orchestratorGetState,
    readStdinText,
    startSleepPrevention,
  };
}

describe("cli", () => {
  it("prints the package version for -V", async () => {
    const originalArgv = [...process.argv];
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(
        `process.exit unexpectedly called with ${JSON.stringify(code)}`,
      );
    }) as typeof process.exit);

    process.argv = ["node", "gnhf", "-V"];

    try {
      vi.resetModules();
      await expect(import("./cli.js")).rejects.toThrow(
        /process\.exit unexpectedly called with 1/,
      );

      expect(stdoutWrite).toHaveBeenCalledWith(`${packageVersion}\n`);
      expect(exitSpy).toHaveBeenNthCalledWith(1, 0);
      expect(exitSpy).toHaveBeenNthCalledWith(2, 1);
    } finally {
      process.argv = originalArgv;
      stdoutWrite.mockRestore();
      consoleError.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("uses config.agent when --agent is not passed", async () => {
    const { loadConfig, createAgent } = await runCliWithMocks(["ship it"], {
      agent: "codex",
      agentPathOverride: {},
      agentArgsOverride: {},
      maxConsecutiveFailures: 3,
      preventSleep: false,
    });

    expect(loadConfig).toHaveBeenCalledWith({});
    expect(createAgent).toHaveBeenCalledWith(
      "codex",
      stubRunInfo,
      undefined,
      undefined,
    );
  });

  it("uses the explicit --agent flag as an override", async () => {
    const { loadConfig, createAgent } = await runCliWithMocks(
      ["ship it", "--agent", "claude"],
      {
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        maxConsecutiveFailures: 3,
        preventSleep: false,
      },
    );

    expect(loadConfig).toHaveBeenCalledWith({ agent: "claude" });
    expect(createAgent).toHaveBeenCalledWith(
      "claude",
      stubRunInfo,
      undefined,
      undefined,
    );
  });

  it("accepts rovodev as an explicit --agent override", async () => {
    const { loadConfig, createAgent } = await runCliWithMocks(
      ["ship it", "--agent", "rovodev"],
      {
        agent: "rovodev",
        agentPathOverride: {},
        agentArgsOverride: {},
        maxConsecutiveFailures: 3,
        preventSleep: false,
      },
    );

    expect(loadConfig).toHaveBeenCalledWith({ agent: "rovodev" });
    expect(createAgent).toHaveBeenCalledWith(
      "rovodev",
      stubRunInfo,
      undefined,
      undefined,
    );
  });

  it("accepts opencode as an explicit --agent override", async () => {
    const { loadConfig, createAgent } = await runCliWithMocks(
      ["ship it", "--agent", "opencode"],
      {
        agent: "opencode",
        agentPathOverride: {},
        agentArgsOverride: {},
        maxConsecutiveFailures: 3,
        preventSleep: false,
      },
    );

    expect(loadConfig).toHaveBeenCalledWith({ agent: "opencode" });
    expect(createAgent).toHaveBeenCalledWith(
      "opencode",
      stubRunInfo,
      undefined,
      undefined,
    );
  });

  it("passes per-agent config through to agent creation", async () => {
    const { createAgent } = await runCliWithMocks(["ship it"], {
      agent: "codex",
      agentPathOverride: {},
      agentArgsOverride: {
        codex: ["-m", "gpt-5.4", "--full-auto"],
      },
      maxConsecutiveFailures: 3,
      preventSleep: false,
    });

    expect(createAgent).toHaveBeenCalledWith("codex", stubRunInfo, undefined, [
      "-m",
      "gpt-5.4",
      "--full-auto",
    ]);
  });

  it("passes max iteration and token caps to the orchestrator", async () => {
    const { orchestratorCtor } = await runCliWithMocks(
      ["ship it", "--max-iterations", "12", "--max-tokens", "3456"],
      {
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        maxConsecutiveFailures: 3,
        preventSleep: false,
      },
    );

    expect(orchestratorCtor).toHaveBeenCalledTimes(1);
    expect(orchestratorCtor.mock.calls[0]?.[6]).toEqual({
      maxIterations: 12,
      maxTokens: 3456,
    });
  });

  it("treats --prevent-sleep as a runtime override without passing it to config bootstrap", async () => {
    const { loadConfig, orchestratorCtor, startSleepPrevention } =
      await runCliWithMocks(["ship it", "--prevent-sleep", "off"], {
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        maxConsecutiveFailures: 3,
        preventSleep: false,
      });

    expect(loadConfig).toHaveBeenCalledWith({});
    expect(startSleepPrevention).not.toHaveBeenCalled();
    expect(orchestratorCtor).toHaveBeenCalledTimes(1);
    expect(orchestratorCtor.mock.calls[0]?.[0]).toEqual({
      agent: "claude",
      agentPathOverride: {},
      agentArgsOverride: {},
      maxConsecutiveFailures: 3,
      preventSleep: false,
    });
  });

  it("does not emit run:start from the Linux sleep-prevention wrapper process", async () => {
    const appendDebugLog = vi.fn();
    const startSleepPrevention = vi.fn(() =>
      Promise.resolve({ type: "reexeced" as const, exitCode: 0 }),
    );

    await expect(
      runCliWithMocks(
        ["ship it"],
        {
          agent: "claude",
          agentPathOverride: {},
          agentArgsOverride: {},
          maxConsecutiveFailures: 3,
          preventSleep: true,
        },
        { appendDebugLog, startSleepPrevention },
      ),
    ).rejects.toThrow(/process\.exit unexpectedly called/);

    expect(startSleepPrevention).toHaveBeenCalledTimes(1);
    expect(appendDebugLog).not.toHaveBeenCalledWith(
      "run:start",
      expect.anything(),
    );
  });

  it("passes the stdin prompt to Linux sleep-prevention re-exec via a temp file", async () => {
    let promptFilePath: string | undefined;
    const readStdinText = vi.fn(() => Promise.resolve("objective from stdin"));
    const startSleepPrevention = vi.fn(async (_argv, deps) => {
      promptFilePath = deps?.reexecEnv?.GNHF_REEXEC_STDIN_PROMPT_FILE;
      expect(promptFilePath).toEqual(expect.any(String));
      expect(deps?.reexecEnv?.GNHF_REEXEC_STDIN_PROMPT).toBeUndefined();
      expect(readFileSync(promptFilePath!, "utf-8")).toBe(
        "objective from stdin",
      );
      return { type: "skipped" as const, reason: "unsupported" };
    });

    await runCliWithMocks(
      [],
      {
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        maxConsecutiveFailures: 3,
        preventSleep: true,
      },
      {
        readStdinText,
        startSleepPrevention,
        stdinIsTTY: false,
      },
    );

    expect(readStdinText).toHaveBeenCalledTimes(1);
    expect(startSleepPrevention).toHaveBeenCalledTimes(1);
    expect(promptFilePath).toBeDefined();
    expect(existsSync(promptFilePath!)).toBe(false);
  });

  it("uses the serialized stdin prompt file after Linux sleep-prevention re-exec", async () => {
    const readStdinText = vi.fn(() => Promise.resolve("should not be read"));
    const startSleepPrevention = vi.fn(() =>
      Promise.resolve({
        type: "skipped" as const,
        reason: "already-inhibited",
      }),
    );
    const promptDir = mkdtempSync(join(tmpdir(), "gnhf-stdin-"));
    const promptPath = join(promptDir, "prompt.txt");
    writeFileSync(promptPath, "objective from stdin", "utf-8");

    try {
      const { orchestratorCtor } = await runCliWithMocks(
        [],
        {
          agent: "claude",
          agentPathOverride: {},
          agentArgsOverride: {},
          maxConsecutiveFailures: 3,
          preventSleep: true,
        },
        {
          env: {
            GNHF_REEXEC_STDIN_PROMPT_FILE: promptPath,
            GNHF_SLEEP_INHIBITED: "1",
          },
          readStdinText,
          startSleepPrevention,
          stdinIsTTY: false,
        },
      );

      expect(readStdinText).not.toHaveBeenCalled();
      expect(startSleepPrevention).toHaveBeenCalledTimes(1);
      expect(orchestratorCtor).toHaveBeenCalledTimes(1);
      expect(orchestratorCtor.mock.calls[0]?.[3]).toBe("objective from stdin");
      expect(existsSync(promptPath)).toBe(false);
      expect(existsSync(dirname(promptPath))).toBe(false);
    } finally {
      rmSync(promptDir, { recursive: true, force: true });
    }
  });

  it("falls back to stdin when Linux sleep inhibition is inherited without a serialized prompt", async () => {
    const readStdinText = vi.fn(() => Promise.resolve("objective from stdin"));
    const startSleepPrevention = vi.fn(() =>
      Promise.resolve({
        type: "skipped" as const,
        reason: "already-inhibited",
      }),
    );

    const { orchestratorCtor } = await runCliWithMocks(
      [],
      {
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        maxConsecutiveFailures: 3,
        preventSleep: true,
      },
      {
        env: {
          GNHF_SLEEP_INHIBITED: "1",
        },
        readStdinText,
        startSleepPrevention,
        stdinIsTTY: false,
      },
    );

    expect(readStdinText).toHaveBeenCalledTimes(1);
    expect(startSleepPrevention).toHaveBeenCalledTimes(1);
    expect(orchestratorCtor).toHaveBeenCalledTimes(1);
    expect(orchestratorCtor.mock.calls[0]?.[3]).toBe("objective from stdin");
  });

  it("clears the serialized stdin prompt file path from process.env after reading it", async () => {
    let inheritedPromptPath: string | undefined;
    const createAgent = vi.fn(() => {
      inheritedPromptPath = process.env.GNHF_REEXEC_STDIN_PROMPT_FILE;
      return { name: "claude" };
    });
    const startSleepPrevention = vi.fn(() =>
      Promise.resolve({
        type: "skipped" as const,
        reason: "already-inhibited",
      }),
    );
    const promptDir = mkdtempSync(join(tmpdir(), "gnhf-stdin-"));
    const promptPath = join(promptDir, "prompt.txt");
    writeFileSync(promptPath, "sensitive prompt", "utf-8");

    try {
      await runCliWithMocks(
        [],
        {
          agent: "claude",
          agentPathOverride: {},
          agentArgsOverride: {},
          maxConsecutiveFailures: 3,
          preventSleep: true,
        },
        {
          createAgent,
          env: {
            GNHF_REEXEC_STDIN_PROMPT_FILE: promptPath,
            GNHF_SLEEP_INHIBITED: "1",
          },
          startSleepPrevention,
        },
      );

      expect(startSleepPrevention).toHaveBeenCalledTimes(1);
      expect(createAgent).toHaveBeenCalledTimes(1);
      expect(inheritedPromptPath).toBeUndefined();
      expect(existsSync(promptPath)).toBe(false);
    } finally {
      rmSync(promptDir, { recursive: true, force: true });
    }
  });

  it("does not recursively delete an untrusted prompt file parent directory", async () => {
    const promptDir = mkdtempSync(join(tmpdir(), "gnhf-cli-test-"));
    const promptPath = join(promptDir, "prompt-from-env.txt");
    const siblingPath = join(promptDir, "keep.txt");
    writeFileSync(promptPath, "prompt from env", "utf-8");
    writeFileSync(siblingPath, "keep me", "utf-8");

    try {
      const { orchestratorCtor } = await runCliWithMocks(
        [],
        {
          agent: "claude",
          agentPathOverride: {},
          agentArgsOverride: {},
          maxConsecutiveFailures: 3,
          preventSleep: true,
        },
        {
          env: {
            GNHF_REEXEC_STDIN_PROMPT_FILE: promptPath,
            GNHF_SLEEP_INHIBITED: "1",
          },
          startSleepPrevention: vi.fn(() =>
            Promise.resolve({
              type: "skipped" as const,
              reason: "already-inhibited",
            }),
          ),
        },
      );

      expect(orchestratorCtor).toHaveBeenCalledTimes(1);
      expect(orchestratorCtor.mock.calls[0]?.[3]).toBe("prompt from env");
      expect(existsSync(promptDir)).toBe(true);
      expect(existsSync(siblingPath)).toBe(true);
    } finally {
      rmSync(promptDir, { recursive: true, force: true });
    }
  });

  it("signals Linux sleep-prevention re-exec readiness before loading config", async () => {
    const loadConfig = vi.fn(() => ({
      agent: "claude" as const,
      agentPathOverride: {},
      agentArgsOverride: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
    }));
    const startSleepPrevention = vi.fn(() =>
      Promise.resolve({
        type: "skipped" as const,
        reason: "already-inhibited",
      }),
    );

    vi.resetModules();
    vi.doMock("./core/config.js", () => ({ loadConfig }));
    vi.doMock("./core/debug-log.js", () => ({
      appendDebugLog: vi.fn(),
      initDebugLog: vi.fn(),
      serializeError: vi.fn((err: unknown) =>
        err instanceof Error
          ? { name: err.name, message: err.message }
          : { value: String(err) },
      ),
    }));
    vi.doMock("./core/git.js", () => ({
      ensureCleanWorkingTree: vi.fn(),
      createBranch: vi.fn(),
      getHeadCommit: vi.fn(() => "abc123"),
      getCurrentBranch: vi.fn(() => "main"),
    }));
    vi.doMock("./core/run.js", () => ({
      setupRun: vi.fn(() => stubRunInfo),
      resumeRun: vi.fn(),
      getLastIterationNumber: vi.fn(() => 0),
    }));
    vi.doMock("./core/stdin.js", () => ({
      readStdinText: vi.fn(() => Promise.resolve("")),
    }));
    vi.doMock("./core/agents/factory.js", () => ({
      createAgent: vi.fn(() => ({ name: "claude" })),
    }));
    vi.doMock("./core/sleep.js", () => ({
      startSleepPrevention,
    }));
    vi.doMock("./core/orchestrator.js", () => ({
      Orchestrator: class MockOrchestrator {
        start = vi.fn(() => Promise.resolve());
        stop = vi.fn();
        on = vi.fn();
        getState = vi.fn(() => ({
          status: "running" as const,
          currentIteration: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          commitCount: 0,
          iterations: [],
          successCount: 0,
          failCount: 0,
          consecutiveFailures: 0,
          startTime: new Date("2026-01-01T00:00:00Z"),
          waitingUntil: null,
          lastMessage: null,
        }));
      },
    }));
    vi.doMock("./renderer.js", () => ({
      Renderer: class MockRenderer {
        start = vi.fn();
        stop = vi.fn();
        waitUntilExit = vi.fn(() => Promise.resolve());
      },
    }));

    const originalArgv = [...process.argv];
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as typeof process.exit);

    process.argv = ["node", "gnhf", "ship it"];
    const originalSleepInhibited = process.env.GNHF_SLEEP_INHIBITED;
    process.env.GNHF_SLEEP_INHIBITED = "1";

    try {
      await import("./cli.js");

      expect(startSleepPrevention).toHaveBeenCalledTimes(1);
      expect(loadConfig).toHaveBeenCalledTimes(1);
      expect(startSleepPrevention.mock.invocationCallOrder[0]).toBeLessThan(
        loadConfig.mock.invocationCallOrder[0] ?? Infinity,
      );
    } finally {
      process.argv = originalArgv;
      if (originalSleepInhibited === undefined) {
        delete process.env.GNHF_SLEEP_INHIBITED;
      } else {
        process.env.GNHF_SLEEP_INHIBITED = originalSleepInhibited;
      }
      stdoutWrite.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("does not start sleep prevention when quitting from the overwrite prompt", async () => {
    const originalArgv = [...process.argv];
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(
        `process.exit unexpectedly called with ${JSON.stringify(code)}`,
      );
    }) as typeof process.exit);
    const startSleepPrevention = vi.fn(() =>
      Promise.resolve({ type: "skipped" as const, reason: "unsupported" }),
    );
    const tempDir = mkdtempSync(join(tmpdir(), "gnhf-cli-test-"));
    const promptPath = join(tempDir, "PROMPT.md");
    writeFileSync(promptPath, "existing prompt", "utf-8");

    vi.resetModules();
    vi.doMock("node:readline", () => ({
      createInterface: vi.fn(() => ({
        question: (_question: string, callback: (answer: string) => void) => {
          callback("q");
        },
        close: vi.fn(),
      })),
    }));
    vi.doMock("./core/config.js", () => ({
      loadConfig: vi.fn(() => ({
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        maxConsecutiveFailures: 3,
        preventSleep: true,
      })),
    }));
    vi.doMock("./core/git.js", () => ({
      ensureCleanWorkingTree: vi.fn(),
      createBranch: vi.fn(),
      getHeadCommit: vi.fn(() => "abc123"),
      getCurrentBranch: vi.fn(() => "gnhf/existing-run"),
    }));
    vi.doMock("./core/run.js", () => ({
      setupRun: vi.fn(() => stubRunInfo),
      resumeRun: vi.fn(() => ({
        ...stubRunInfo,
        runId: "existing-run",
        promptPath,
      })),
      getLastIterationNumber: vi.fn(() => 3),
    }));
    vi.doMock("./core/agents/factory.js", () => ({
      createAgent: vi.fn(() => ({ name: "claude" })),
    }));
    vi.doMock("./core/sleep.js", () => ({
      startSleepPrevention,
    }));
    vi.doMock("./core/orchestrator.js", () => ({
      Orchestrator: class MockOrchestrator {
        start = vi.fn(() => Promise.resolve());
        stop = vi.fn();
        on = vi.fn();
        getState = vi.fn();
      },
    }));
    vi.doMock("./renderer.js", () => ({
      Renderer: class MockRenderer {
        start = vi.fn();
        stop = vi.fn();
        waitUntilExit = vi.fn(() => Promise.resolve());
      },
    }));

    process.argv = ["node", "gnhf", "new prompt"];

    try {
      await expect(import("./cli.js")).rejects.toThrow(
        /process\.exit unexpectedly called with 1/,
      );

      expect(startSleepPrevention).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenNthCalledWith(1, 0);
      expect(exitSpy).toHaveBeenNthCalledWith(2, 1);
    } finally {
      process.argv = originalArgv;
      stdoutWrite.mockRestore();
      consoleError.mockRestore();
      exitSpy.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("waits for orchestrator shutdown after the renderer exits", async () => {
    let resolveStart!: () => void;
    const orchestratorStart = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const rendererWaitUntilExit = vi.fn(() => Promise.resolve());

    const cliPromise = runCliWithMocks(
      ["ship it"],
      {
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        maxConsecutiveFailures: 3,
        preventSleep: false,
      },
      { orchestratorStart, rendererWaitUntilExit },
    );

    await vi.waitFor(() => {
      expect(orchestratorStart).toHaveBeenCalledTimes(1);
    });
    const state = await Promise.race([
      cliPromise.then(() => "done"),
      Promise.resolve("pending"),
    ]);
    expect(state).toBe("pending");

    resolveStart();
    await cliPromise;
  });

  it("stops the renderer when the orchestrator finishes normally", async () => {
    let resolveRendererExit!: () => void;
    const rendererStop = vi.fn(() => {
      resolveRendererExit();
    });
    const rendererWaitUntilExit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRendererExit = resolve;
        }),
    );

    const cliPromise = runCliWithMocks(
      ["ship it"],
      {
        agent: "opencode",
        agentPathOverride: {},
        agentArgsOverride: {},
        maxConsecutiveFailures: 3,
        preventSleep: false,
      },
      {
        orchestratorStart: vi.fn(() => Promise.resolve()),
        rendererStop,
        rendererWaitUntilExit,
      },
    );

    await vi.waitFor(() => {
      expect(rendererStop).toHaveBeenCalledTimes(1);
    });

    await cliPromise;
  });

  it("prints a friendly message outside a git repository", async () => {
    const originalArgv = [...process.argv];
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(
        `process.exit unexpectedly called with ${JSON.stringify(code)}`,
      );
    }) as typeof process.exit);

    vi.resetModules();
    vi.doMock("./core/config.js", () => ({
      loadConfig: vi.fn(() => ({
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        maxConsecutiveFailures: 3,
        preventSleep: false,
      })),
    }));
    vi.doMock("./core/git.js", () => ({
      ensureCleanWorkingTree: vi.fn(),
      createBranch: vi.fn(),
      getHeadCommit: vi.fn(() => "abc123"),
      getCurrentBranch: vi.fn(() => {
        throw new Error(
          [
            "Command failed: git rev-parse --abbrev-ref HEAD",
            "fatal: not a git repository (or any of the parent directories): .git",
          ].join("\n"),
        );
      }),
    }));

    process.argv = ["node", "gnhf", "ship it"];

    try {
      await expect(import("./cli.js")).rejects.toThrow(
        /process\.exit unexpectedly called with 1/,
      );

      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          'gnhf: This command must be run inside a Git repository. Change into a repo or run "git init" first.',
        ),
      );
    } finally {
      process.argv = originalArgv;
      stdoutWrite.mockRestore();
      consoleError.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("uses the SIGTERM exit code when shutdown times out after SIGTERM", async () => {
    vi.useFakeTimers();

    const originalArgv = [...process.argv];
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as typeof process.exit);
    const processOn = vi.spyOn(process, "on");
    const processOff = vi.spyOn(process, "off");
    const signalHandlers = new Map<string, () => void>();
    processOn.mockImplementation(((event: string, listener: () => void) => {
      if (event === "SIGINT" || event === "SIGTERM") {
        signalHandlers.set(event, listener);
      }
      return process;
    }) as typeof process.on);
    processOff.mockImplementation((() => process) as typeof process.off);

    let resolveRendererExit!: () => void;
    const rendererWaitUntilExit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRendererExit = resolve;
        }),
    );

    vi.resetModules();
    vi.doMock("./core/config.js", () => ({
      loadConfig: vi.fn(() => ({
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        maxConsecutiveFailures: 3,
        preventSleep: false,
      })),
    }));
    vi.doMock("./core/git.js", () => ({
      ensureCleanWorkingTree: vi.fn(),
      createBranch: vi.fn(),
      getHeadCommit: vi.fn(() => "abc123"),
      getCurrentBranch: vi.fn(() => "main"),
    }));
    vi.doMock("./core/run.js", () => ({
      setupRun: vi.fn(() => stubRunInfo),
      resumeRun: vi.fn(),
      getLastIterationNumber: vi.fn(() => 0),
    }));
    vi.doMock("./core/agents/factory.js", () => ({
      createAgent: vi.fn(() => ({ name: "claude" })),
    }));
    vi.doMock("./core/orchestrator.js", () => ({
      Orchestrator: class MockOrchestrator {
        start = vi.fn(() => new Promise<void>(() => {}));
        stop = vi.fn();
        on = vi.fn();
        getState = vi.fn(() => ({
          status: "running" as const,
          currentIteration: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          commitCount: 0,
          iterations: [],
          successCount: 0,
          failCount: 0,
          consecutiveFailures: 0,
          startTime: new Date("2026-01-01T00:00:00Z"),
          waitingUntil: null,
          lastMessage: null,
        }));
      },
    }));
    vi.doMock("./renderer.js", () => ({
      Renderer: class MockRenderer {
        start = vi.fn();
        stop = vi.fn(() => {
          resolveRendererExit();
        });
        waitUntilExit = rendererWaitUntilExit;
      },
    }));

    process.argv = ["node", "gnhf", "ship it"];

    try {
      const cliPromise = import("./cli.js");

      await vi.waitFor(() => {
        expect(signalHandlers.has("SIGTERM")).toBe(true);
      });

      signalHandlers.get("SIGTERM")?.();
      await vi.advanceTimersByTimeAsync(5_000);

      await cliPromise;

      expect(exitSpy).toHaveBeenCalledWith(143);
      expect(exitSpy).not.toHaveBeenCalledWith(130);
    } finally {
      process.argv = originalArgv;
      stdoutWrite.mockRestore();
      consoleError.mockRestore();
      exitSpy.mockRestore();
      processOn.mockRestore();
      processOff.mockRestore();
      vi.useRealTimers();
    }
  });

  it("uses the SIGINT exit code when the renderer reports an interactive interrupt", async () => {
    const originalArgv = [...process.argv];
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as typeof process.exit);

    vi.resetModules();
    vi.doMock("./core/config.js", () => ({
      loadConfig: vi.fn(() => ({
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        maxConsecutiveFailures: 3,
        preventSleep: false,
      })),
    }));
    vi.doMock("./core/git.js", () => ({
      ensureCleanWorkingTree: vi.fn(),
      createBranch: vi.fn(),
      getHeadCommit: vi.fn(() => "abc123"),
      getCurrentBranch: vi.fn(() => "main"),
    }));
    vi.doMock("./core/run.js", () => ({
      setupRun: vi.fn(() => stubRunInfo),
      resumeRun: vi.fn(),
      getLastIterationNumber: vi.fn(() => 0),
    }));
    vi.doMock("./core/agents/factory.js", () => ({
      createAgent: vi.fn(() => ({ name: "claude" })),
    }));
    vi.doMock("./core/orchestrator.js", () => ({
      Orchestrator: class MockOrchestrator {
        start = vi.fn(() => Promise.resolve());
        stop = vi.fn();
        on = vi.fn();
        getState = vi.fn(() => ({
          status: "running" as const,
          currentIteration: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          commitCount: 0,
          iterations: [],
          successCount: 0,
          failCount: 0,
          consecutiveFailures: 0,
          startTime: new Date("2026-01-01T00:00:00Z"),
          waitingUntil: null,
          lastMessage: null,
        }));
      },
    }));
    vi.doMock("./renderer.js", () => ({
      Renderer: class MockRenderer {
        start = vi.fn();
        stop = vi.fn();
        waitUntilExit = vi.fn(() => Promise.resolve("interrupted"));
      },
    }));

    process.argv = ["node", "gnhf", "ship it"];

    try {
      await import("./cli.js");

      expect(exitSpy).toHaveBeenCalledWith(130);
      expect(exitSpy).not.toHaveBeenCalledWith(0);
    } finally {
      process.argv = originalArgv;
      stdoutWrite.mockRestore();
      consoleError.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("passes the worktree path as effectiveCwd to the orchestrator in --worktree mode", async () => {
    const createWorktree = vi.fn();
    const getRepoRootDir = vi.fn(() => "/repo");

    const { orchestratorCtor, appendDebugLog } = await runCliWithMocks(
      ["ship it", "--worktree"],
      {
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        maxConsecutiveFailures: 3,
        preventSleep: false,
      },
      { createWorktree, getRepoRootDir },
    );

    expect(getRepoRootDir).toHaveBeenCalled();
    expect(createWorktree).toHaveBeenCalledWith(
      "/repo",
      expect.stringContaining(`repo-gnhf-worktrees${sep}`),
      expect.stringMatching(/^gnhf\//),
    );
    expect(orchestratorCtor).toHaveBeenCalledTimes(1);
    const effectiveCwd = orchestratorCtor.mock.calls[0]?.[4];
    expect(effectiveCwd).toContain(`repo-gnhf-worktrees${sep}`);
    expect(appendDebugLog).toHaveBeenCalledWith(
      "run:start",
      expect.objectContaining({ worktree: true }),
    );
  });

  it("exits with error when --worktree is used from a gnhf branch", async () => {
    const originalArgv = [...process.argv];
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(
        `process.exit unexpectedly called with ${JSON.stringify(code)}`,
      );
    }) as typeof process.exit);

    vi.resetModules();
    vi.doMock("./core/config.js", () => ({
      loadConfig: vi.fn(() => ({
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        maxConsecutiveFailures: 3,
        preventSleep: false,
      })),
    }));
    vi.doMock("./core/debug-log.js", () => ({
      appendDebugLog: vi.fn(),
      initDebugLog: vi.fn(),
      serializeError: vi.fn(),
    }));
    vi.doMock("./core/git.js", () => ({
      ensureCleanWorkingTree: vi.fn(),
      createBranch: vi.fn(),
      getHeadCommit: vi.fn(() => "abc123"),
      getCurrentBranch: vi.fn(() => "gnhf/existing-run"),
      getRepoRootDir: vi.fn(() => "/repo"),
      createWorktree: vi.fn(),
      removeWorktree: vi.fn(),
    }));
    vi.doMock("./core/run.js", () => ({
      setupRun: vi.fn(() => stubRunInfo),
      resumeRun: vi.fn(() => ({
        ...stubRunInfo,
        promptPath: "/repo/.gnhf/runs/existing-run/PROMPT.md",
      })),
      getLastIterationNumber: vi.fn(() => 0),
    }));
    vi.doMock("./core/agents/factory.js", () => ({
      createAgent: vi.fn(() => ({ name: "claude" })),
    }));
    vi.doMock("./core/orchestrator.js", () => ({
      Orchestrator: class MockOrchestrator {
        start = vi.fn(() => Promise.resolve());
        stop = vi.fn();
        on = vi.fn();
        getState = vi.fn();
      },
    }));
    vi.doMock("./renderer.js", () => ({
      Renderer: class MockRenderer {
        start = vi.fn();
        stop = vi.fn();
        waitUntilExit = vi.fn(() => Promise.resolve());
      },
    }));

    process.argv = ["node", "gnhf", "new objective", "--worktree"];

    try {
      await expect(import("./cli.js")).rejects.toThrow(
        /process\.exit unexpectedly called with 1/,
      );

      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("Cannot use --worktree from a gnhf branch"),
      );
    } finally {
      process.argv = originalArgv;
      stdoutWrite.mockRestore();
      consoleError.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("cleans up the worktree when no commits were made", async () => {
    const removeWorktree = vi.fn();

    await runCliWithMocks(
      ["ship it", "--worktree"],
      {
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        maxConsecutiveFailures: 3,
        preventSleep: false,
      },
      {
        removeWorktree,
        orchestratorGetState: vi.fn(() => ({
          status: "completed" as const,
          currentIteration: 1,
          totalInputTokens: 100,
          totalOutputTokens: 200,
          commitCount: 0,
          iterations: [],
          successCount: 0,
          failCount: 1,
          consecutiveFailures: 1,
          startTime: new Date("2026-01-01T00:00:00Z"),
          waitingUntil: null,
          lastMessage: null,
        })),
      },
    );

    expect(removeWorktree).toHaveBeenCalled();
  });

  it("preserves the worktree when commits were made", async () => {
    const removeWorktree = vi.fn();

    await runCliWithMocks(
      ["ship it", "--worktree"],
      {
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        maxConsecutiveFailures: 3,
        preventSleep: false,
      },
      {
        removeWorktree,
        orchestratorGetState: vi.fn(() => ({
          status: "completed" as const,
          currentIteration: 3,
          totalInputTokens: 500,
          totalOutputTokens: 1000,
          commitCount: 2,
          iterations: [],
          successCount: 2,
          failCount: 1,
          consecutiveFailures: 0,
          startTime: new Date("2026-01-01T00:00:00Z"),
          waitingUntil: null,
          lastMessage: null,
        })),
      },
    );

    expect(removeWorktree).not.toHaveBeenCalled();
  });
});
