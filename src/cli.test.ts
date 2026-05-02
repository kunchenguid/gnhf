import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CONVENTIONAL_COMMIT_MESSAGE } from "./core/commit-message.js";
import type { Config } from "./core/config.js";
import type { RunInfo } from "./core/run.js";

const TEST_AGENT_NAMES = [
  "claude",
  "codex",
  "rovodev",
  "opencode",
  "copilot",
  "pi",
];
const TEST_IS_AGENT_SPEC = (name: string) =>
  TEST_AGENT_NAMES.includes(name) || /^acp:\S+/.test(name);

const stubRunInfo: RunInfo = {
  runId: "run-abc",
  runDir: "/repo/.gnhf/runs/run-abc",
  promptPath: "/repo/.gnhf/runs/run-abc/PROMPT.md",
  notesPath: "/repo/.gnhf/runs/run-abc/notes.md",
  schemaPath: "/repo/.gnhf/runs/run-abc/schema.json",
  logPath: "/repo/.gnhf/runs/run-abc/gnhf.log",
  baseCommit: "abc123",
  baseCommitPath: "/repo/.gnhf/runs/run-abc/base-commit",
  stopWhenPath: "/repo/.gnhf/runs/run-abc/stop-when",
  stopWhen: undefined,
  commitMessagePath: "/repo/.gnhf/runs/run-abc/commit-message",
  commitMessage: undefined,
};

interface CliMockOverrides {
  appendDebugLog?: ReturnType<typeof vi.fn>;
  initDebugLog?: ReturnType<typeof vi.fn>;
  createAgent?: ReturnType<typeof vi.fn>;
  env?: Record<string, string | undefined>;
  getCurrentBranch?: ReturnType<typeof vi.fn>;
  getRepoRootDir?: ReturnType<typeof vi.fn>;
  createBranch?: ReturnType<typeof vi.fn>;
  createWorktree?: ReturnType<typeof vi.fn>;
  removeWorktree?: ReturnType<typeof vi.fn>;
  listWorktreePaths?: ReturnType<typeof vi.fn>;
  worktreeExists?: ReturnType<typeof vi.fn>;
  peekRunMetadata?: ReturnType<typeof vi.fn>;
  resumeRun?: ReturnType<typeof vi.fn>;
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
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
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
  let consoleErrorCalls: unknown[][] = [];
  const setupRun = vi.fn(() => stubRunInfo);
  const peekRunMetadata = overrides.peekRunMetadata ?? vi.fn(() => stubRunInfo);

  const orchestratorStart =
    overrides.orchestratorStart ?? vi.fn(() => Promise.resolve());
  const orchestratorStop = vi.fn();
  const orchestratorRequestGracefulStop = vi.fn();
  const orchestratorHandleInterrupt = vi.fn(
    () => "request-graceful-stop" as const,
  );
  const orchestratorOn = vi.fn();
  const orchestratorGetState =
    overrides.orchestratorGetState ??
    vi.fn(() => ({
      status: "running" as const,
      gracefulStopRequested: false,
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
  vi.doMock("./core/config.js", () => ({
    AGENT_NAMES: TEST_AGENT_NAMES,
    isAgentSpec: TEST_IS_AGENT_SPEC,
    loadConfig,
  }));
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
    createBranch: overrides.createBranch ?? vi.fn(),
    getHeadCommit: vi.fn(() => "abc123"),
    getCurrentBranch: overrides.getCurrentBranch ?? vi.fn(() => "main"),
    getRepoRootDir: overrides.getRepoRootDir ?? vi.fn(() => "/repo"),
    createWorktree: overrides.createWorktree ?? vi.fn(),
    removeWorktree: overrides.removeWorktree ?? vi.fn(),
    listWorktreePaths: overrides.listWorktreePaths ?? vi.fn(() => new Set()),
    worktreeExists: overrides.worktreeExists ?? vi.fn(() => false),
  }));
  vi.doMock("./core/run.js", () => ({
    setupRun,
    peekRunMetadata,
    resumeRun: overrides.resumeRun ?? vi.fn(),
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
      requestGracefulStop = orchestratorRequestGracefulStop;
      handleInterrupt = orchestratorHandleInterrupt;
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
    consoleErrorCalls = [...consoleError.mock.calls];
    consoleError.mockRestore();
    exitSpy.mockRestore();
  }

  return {
    appendDebugLog,
    consoleError,
    consoleErrorCalls,
    loadConfig,
    createAgent,
    setupRun,
    peekRunMetadata,
    orchestratorCtor,
    orchestratorGetState,
    orchestratorRequestGracefulStop,
    readStdinText,
    startSleepPrevention,
  };
}

async function runSigintCliTest({
  forceOnSecondSigint,
  initialStatus = "running",
}: {
  forceOnSecondSigint: boolean;
  initialStatus?: "running" | "aborted" | "stopped";
}): Promise<{
  exitSpy: ReturnType<typeof vi.spyOn>;
  consoleError: ReturnType<typeof vi.spyOn>;
  orchestratorStop: ReturnType<typeof vi.fn>;
  orchestratorRequestGracefulStop: ReturnType<typeof vi.fn>;
  rendererStop: ReturnType<typeof vi.fn>;
}> {
  const originalArgv = [...process.argv];
  const stdoutWrite = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
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

  let resolveStart!: () => void;
  let resolveRendererExit!: () => void;
  const rendererExitPromise = new Promise<void>((resolve) => {
    resolveRendererExit = resolve;
  });
  const state = {
    status: initialStatus,
    gracefulStopRequested: false,
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
  };
  const rendererStop = vi.fn(() => {
    resolveRendererExit();
  });
  const orchestratorStop = vi.fn();
  const orchestratorRequestGracefulStop = vi.fn(() => {
    state.gracefulStopRequested = true;
    if (!forceOnSecondSigint) {
      resolveStart();
    }
  });
  const orchestratorHandleInterrupt = vi.fn(() => {
    if (state.status === "aborted") {
      return "exit" as const;
    }
    if (state.gracefulStopRequested || state.status === "stopped") {
      orchestratorStop();
      return "force-stop" as const;
    }
    orchestratorRequestGracefulStop();
    return "request-graceful-stop" as const;
  });

  vi.resetModules();
  vi.doMock("./core/config.js", () => ({
    AGENT_NAMES: TEST_AGENT_NAMES,
    isAgentSpec: TEST_IS_AGENT_SPEC,
    loadConfig: vi.fn(() => ({
      agent: "claude",
      agentPathOverride: {},
      agentArgsOverride: {},
      acpRegistryOverrides: {},
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
    peekRunMetadata: vi.fn(() => stubRunInfo),
    resumeRun: vi.fn(),
    getLastIterationNumber: vi.fn(() => 0),
  }));
  vi.doMock("./core/agents/factory.js", () => ({
    createAgent: vi.fn(() => ({ name: "claude" })),
  }));
  vi.doMock("./core/orchestrator.js", () => ({
    Orchestrator: class MockOrchestrator {
      start = vi.fn(() => {
        if (forceOnSecondSigint) {
          return new Promise<void>(() => {});
        }
        if (initialStatus !== "running") {
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
          resolveStart = resolve;
        });
      });
      stop = orchestratorStop;
      requestGracefulStop = orchestratorRequestGracefulStop;
      handleInterrupt = orchestratorHandleInterrupt;
      on = vi.fn();
      getState = vi.fn(() => state);
    },
  }));
  vi.doMock("./renderer.js", () => ({
    Renderer: class MockRenderer {
      start = vi.fn();
      stop = rendererStop;
      waitUntilExit = vi.fn(() => rendererExitPromise);
    },
  }));

  process.argv = ["node", "gnhf", "ship it"];

  try {
    const cliPromise = import("./cli.js");

    await vi.waitFor(() => {
      expect(signalHandlers.has("SIGINT")).toBe(true);
    });

    signalHandlers.get("SIGINT")?.();
    if (forceOnSecondSigint) {
      signalHandlers.get("SIGINT")?.();
      await vi.advanceTimersByTimeAsync(5_000);
    } else {
      await Promise.resolve();
      if (rendererStop.mock.calls.length === 0 && initialStatus !== "running") {
        rendererStop();
      }
    }
    await cliPromise;

    return {
      exitSpy,
      consoleError,
      orchestratorStop,
      orchestratorRequestGracefulStop,
      rendererStop,
    };
  } finally {
    process.argv = originalArgv;
    stdoutWrite.mockRestore();
    consoleError.mockRestore();
    processOn.mockRestore();
    processOff.mockRestore();
    if (forceOnSecondSigint) {
      vi.useRealTimers();
    }
  }
}

async function importCliExpectError(timeoutMs = 250): Promise<unknown> {
  return Promise.race([
    import("./cli.js").then(
      () => "resolved",
      (error) => error,
    ),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("cli import timed out")), timeoutMs);
    }),
  ]);
}

async function runCliResumeWithActualRun(
  args: string[],
  storedStopWhen?: string,
  opts: {
    liveCommitMessage?: typeof CONVENTIONAL_COMMIT_MESSAGE;
    storedCommitMessage?: "default" | "conventional";
  } = {},
) {
  const originalArgv = [...process.argv];
  const originalCwd = process.cwd();
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
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

  const tempDir = mkdtempSync(join(tmpdir(), "gnhf-cli-resume-test-"));
  const runDir = join(tempDir, ".gnhf", "runs", "existing-run");
  const promptPath = join(runDir, "prompt.md");
  const baseCommitPath = join(runDir, "base-commit");
  const stopWhenPath = join(runDir, "stop-when");
  const commitMessagePath = join(runDir, "commit-message");
  const schemaPath = join(runDir, "output-schema.json");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(promptPath, "existing prompt", "utf-8");
  writeFileSync(baseCommitPath, "abc123\n", "utf-8");
  if (storedStopWhen !== undefined) {
    writeFileSync(stopWhenPath, `${storedStopWhen}\n`, "utf-8");
  }
  if (opts.storedCommitMessage !== undefined) {
    writeFileSync(commitMessagePath, `${opts.storedCommitMessage}\n`, "utf-8");
  }

  const appendDebugLog = vi.fn();
  const createAgent = vi.fn(() => ({ name: "claude" }));
  const orchestratorCtor = vi.fn();

  vi.resetModules();
  vi.doUnmock("./core/run.js");
  vi.doMock("./core/config.js", () => ({
    AGENT_NAMES: TEST_AGENT_NAMES,
    isAgentSpec: TEST_IS_AGENT_SPEC,
    loadConfig: vi.fn(() => ({
      agent: "claude",
      agentPathOverride: {},
      agentArgsOverride: {},
      acpRegistryOverrides: {},
      ...(opts.liveCommitMessage === undefined
        ? {}
        : { commitMessage: opts.liveCommitMessage }),
      maxConsecutiveFailures: 3,
      preventSleep: false,
    })),
  }));
  vi.doMock("./core/debug-log.js", () => ({
    appendDebugLog,
    initDebugLog: vi.fn(),
    serializeError: vi.fn(),
  }));
  vi.doMock("./core/git.js", () => ({
    ensureCleanWorkingTree: vi.fn(),
    createBranch: vi.fn(),
    getHeadCommit: vi.fn(() => "abc123"),
    getCurrentBranch: vi.fn(() => "gnhf/existing-run"),
    getRepoRootDir: vi.fn(() => tempDir),
    createWorktree: vi.fn(),
    removeWorktree: vi.fn(),
  }));
  vi.doMock("./core/agents/factory.js", () => ({ createAgent }));
  vi.doMock("./core/sleep.js", () => ({
    startSleepPrevention: vi.fn(() =>
      Promise.resolve({ type: "skipped", reason: "unsupported" }),
    ),
  }));
  vi.doMock("./core/orchestrator.js", () => ({
    Orchestrator: class MockOrchestrator {
      constructor(...ctorArgs: unknown[]) {
        orchestratorCtor(...ctorArgs);
      }
      start = vi.fn(() => Promise.resolve());
      stop = vi.fn();
      on = vi.fn();
      getState = vi.fn(() => ({
        status: "completed" as const,
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

  let result!: {
    appendDebugLog: typeof appendDebugLog;
    createAgent: typeof createAgent;
    orchestratorCtor: typeof orchestratorCtor;
    schema: Record<string, unknown>;
    stopWhenExists: boolean;
    stopWhenContent?: string;
    commitMessageExists: boolean;
    commitMessageContent?: string;
  };

  try {
    process.chdir(tempDir);
    process.argv = ["node", "gnhf", ...args];
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });

    await import("./cli.js");

    const stopWhenExists = existsSync(stopWhenPath);
    const commitMessageExists = existsSync(commitMessagePath);
    result = {
      appendDebugLog,
      createAgent,
      orchestratorCtor,
      schema: JSON.parse(readFileSync(schemaPath, "utf-8")) as Record<
        string,
        unknown
      >,
      stopWhenExists,
      stopWhenContent: stopWhenExists
        ? readFileSync(stopWhenPath, "utf-8")
        : undefined,
      commitMessageExists,
      commitMessageContent: commitMessageExists
        ? readFileSync(commitMessagePath, "utf-8")
        : undefined,
    };
  } finally {
    process.argv = originalArgv;
    process.chdir(originalCwd);
    if (originalIsTTY) {
      Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
    }
    stdoutWrite.mockRestore();
    exitSpy.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
  }

  return result;
}

describe("cli", () => {
  it("passes per-agent config through to agent creation", async () => {
    const { createAgent } = await runCliWithMocks(["ship it"], {
      agent: "codex",
      agentPathOverride: {},
      agentArgsOverride: {
        codex: ["-m", "gpt-5.4", "--full-auto"],
      },
      acpRegistryOverrides: {},
      maxConsecutiveFailures: 3,
      preventSleep: false,
    });

    expect(createAgent).toHaveBeenCalledWith(
      "codex",
      stubRunInfo,
      undefined,
      ["-m", "gpt-5.4", "--full-auto"],
      { includeStopField: false, acpRegistryOverrides: {} },
    );
  });

  it("threads includeStopField=true into agent creation when --stop-when is set", async () => {
    const { createAgent } = await runCliWithMocks(
      ["ship it", "--stop-when", "all tests pass"],
      {
        agent: "codex",
        agentPathOverride: {},
        agentArgsOverride: {},
        acpRegistryOverrides: {},
        maxConsecutiveFailures: 3,
        preventSleep: false,
      },
    );

    expect(createAgent).toHaveBeenCalledWith(
      "codex",
      stubRunInfo,
      undefined,
      undefined,
      {
        includeStopField: true,
        stopWhen: "all tests pass",
        acpRegistryOverrides: {},
      },
    );
  });

  it("threads commit message fields into run setup and agent creation", async () => {
    const { createAgent, setupRun } = await runCliWithMocks(["ship it"], {
      agent: "codex",
      agentPathOverride: {},
      agentArgsOverride: {},
      acpRegistryOverrides: {},
      commitMessage: CONVENTIONAL_COMMIT_MESSAGE,
      maxConsecutiveFailures: 3,
      preventSleep: false,
    });

    const expectedSchemaOptions = {
      includeStopField: false,
      commitMessage: CONVENTIONAL_COMMIT_MESSAGE,
      commitFields: [
        {
          name: "type",
          allowed: [
            "build",
            "ci",
            "docs",
            "feat",
            "fix",
            "perf",
            "refactor",
            "test",
            "chore",
          ],
        },
        { name: "scope" },
      ],
    };
    expect(setupRun).toHaveBeenCalledWith(
      expect.stringMatching(/^ship-it-/),
      "ship it",
      "abc123",
      process.cwd(),
      expectedSchemaOptions,
    );
    expect(createAgent).toHaveBeenCalledWith(
      "codex",
      stubRunInfo,
      undefined,
      undefined,
      { ...expectedSchemaOptions, acpRegistryOverrides: {} },
    );
  });

  it("combines stop-when and commit message fields in schema options", async () => {
    const { createAgent, setupRun } = await runCliWithMocks(
      ["ship it", "--stop-when", "all checks pass"],
      {
        agent: "codex",
        agentPathOverride: {},
        agentArgsOverride: {},
        acpRegistryOverrides: {},
        commitMessage: CONVENTIONAL_COMMIT_MESSAGE,
        maxConsecutiveFailures: 3,
        preventSleep: false,
      },
    );

    const expectedSchemaOptions = {
      includeStopField: true,
      stopWhen: "all checks pass",
      commitMessage: CONVENTIONAL_COMMIT_MESSAGE,
      commitFields: [
        {
          name: "type",
          allowed: [
            "build",
            "ci",
            "docs",
            "feat",
            "fix",
            "perf",
            "refactor",
            "test",
            "chore",
          ],
        },
        { name: "scope" },
      ],
    };
    expect(setupRun).toHaveBeenCalledWith(
      expect.stringMatching(/^ship-it-/),
      "ship it",
      "abc123",
      process.cwd(),
      expectedSchemaOptions,
    );
    expect(createAgent).toHaveBeenCalledWith(
      "codex",
      stubRunInfo,
      undefined,
      undefined,
      { ...expectedSchemaOptions, acpRegistryOverrides: {} },
    );
  });

  it("reuses the persisted stop-when condition when resuming without --stop-when", async () => {
    const { appendDebugLog, createAgent, orchestratorCtor, schema } =
      await runCliResumeWithActualRun([], "all tests pass");

    expect(createAgent).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({ stopWhen: "all tests pass" }),
      undefined,
      undefined,
      {
        includeStopField: true,
        stopWhen: "all tests pass",
        acpRegistryOverrides: {},
      },
    );
    expect(orchestratorCtor.mock.calls[0]?.[6]).toMatchObject({
      stopWhen: "all tests pass",
    });
    expect(schema).toMatchObject({
      properties: expect.objectContaining({
        should_fully_stop: { type: "boolean" },
      }),
    });
    expect(appendDebugLog).toHaveBeenCalledWith(
      "run:start",
      expect.objectContaining({ stopWhen: "all tests pass" }),
    );
  });

  it("overwrites the persisted stop-when condition when resuming with a new value", async () => {
    const { orchestratorCtor, schema, stopWhenContent } =
      await runCliResumeWithActualRun(
        ["--stop-when", "all checks pass"],
        "old condition",
      );

    expect(stopWhenContent).toBe("all checks pass\n");
    expect(orchestratorCtor.mock.calls[0]?.[6]).toMatchObject({
      stopWhen: "all checks pass",
    });
    expect(schema).toMatchObject({
      properties: expect.objectContaining({
        should_fully_stop: { type: "boolean" },
      }),
    });
  });

  it("clears the persisted stop-when condition when resuming with an empty value", async () => {
    const { orchestratorCtor, schema, stopWhenExists } =
      await runCliResumeWithActualRun(["--stop-when", ""], "old condition");

    expect(stopWhenExists).toBe(false);
    expect(orchestratorCtor.mock.calls[0]?.[6]).toEqual({
      maxIterations: undefined,
      maxTokens: undefined,
      stopWhen: undefined,
    });
    expect(
      (schema.properties as Record<string, unknown>).should_fully_stop,
    ).toBe(undefined);
    expect(schema.required).not.toContain("should_fully_stop");
  });

  it("keeps resume behavior unchanged when no stop-when condition exists", async () => {
    const { createAgent, orchestratorCtor, schema, stopWhenExists } =
      await runCliResumeWithActualRun([]);

    expect(stopWhenExists).toBe(false);
    expect(createAgent).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({ stopWhen: undefined }),
      undefined,
      undefined,
      { includeStopField: false, acpRegistryOverrides: {} },
    );
    expect(orchestratorCtor.mock.calls[0]?.[6]).toEqual({
      maxIterations: undefined,
      maxTokens: undefined,
      stopWhen: undefined,
    });
    expect(
      (schema.properties as Record<string, unknown>).should_fully_stop,
    ).toBe(undefined);
  });

  it("keeps a resumed default commit message run on the default convention when live config changes", async () => {
    const { createAgent, orchestratorCtor, schema } =
      await runCliResumeWithActualRun([], undefined, {
        liveCommitMessage: CONVENTIONAL_COMMIT_MESSAGE,
        storedCommitMessage: "default",
      });

    expect(createAgent).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({ commitMessage: undefined }),
      undefined,
      undefined,
      { includeStopField: false, acpRegistryOverrides: {} },
    );
    expect(orchestratorCtor.mock.calls[0]?.[0]).toMatchObject({
      commitMessage: undefined,
    });
    expect((schema.properties as Record<string, unknown>).type).toBeUndefined();
    expect(
      (schema.properties as Record<string, unknown>).scope,
    ).toBeUndefined();
  });

  it("keeps a resumed conventional commit message run conventional when live config changes", async () => {
    const { createAgent, orchestratorCtor, schema } =
      await runCliResumeWithActualRun([], undefined, {
        storedCommitMessage: "conventional",
      });

    expect(createAgent).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({ commitMessage: CONVENTIONAL_COMMIT_MESSAGE }),
      undefined,
      undefined,
      expect.objectContaining({
        includeStopField: false,
        commitFields: expect.arrayContaining([
          expect.objectContaining({ name: "type" }),
          expect.objectContaining({ name: "scope" }),
        ]),
      }),
    );
    expect(orchestratorCtor.mock.calls[0]?.[0]).toMatchObject({
      commitMessage: CONVENTIONAL_COMMIT_MESSAGE,
    });
    expect((schema.properties as Record<string, unknown>).type).toBeDefined();
    expect((schema.properties as Record<string, unknown>).scope).toBeDefined();
  });

  it("passes max iteration and token caps to the orchestrator", async () => {
    const { orchestratorCtor } = await runCliWithMocks(
      ["ship it", "--max-iterations", "12", "--max-tokens", "3456"],
      {
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        acpRegistryOverrides: {},
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
        acpRegistryOverrides: {},
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
      acpRegistryOverrides: {},
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
          acpRegistryOverrides: {},
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
        acpRegistryOverrides: {},
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
          acpRegistryOverrides: {},
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
        acpRegistryOverrides: {},
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
          acpRegistryOverrides: {},
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
          acpRegistryOverrides: {},
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
      acpRegistryOverrides: {},
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
    vi.doMock("./core/config.js", () => ({
      AGENT_NAMES: TEST_AGENT_NAMES,
      isAgentSpec: TEST_IS_AGENT_SPEC,
      loadConfig,
    }));
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
      peekRunMetadata: vi.fn(() => stubRunInfo),
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

  it("uses the controlling terminal for the overwrite prompt when stdin is piped", async () => {
    const inputPath = process.platform === "win32" ? "CONIN$" : "/dev/tty";
    const outputPath = process.platform === "win32" ? "CONOUT$" : "/dev/tty";
    const inputFd = 123;
    const outputFd = process.platform === "win32" ? 124 : inputFd;
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
    const ttyInput = { destroy: vi.fn(), isTTY: true };
    const ttyOutput = { destroy: vi.fn(), isTTY: true };
    const openSync = vi.fn((path: string) => {
      if (path === inputPath) return inputFd;
      if (path === outputPath) return outputFd;
      throw new Error(`unexpected open path: ${path}`);
    });
    const createReadStream = vi.fn(() => ttyInput);
    const createWriteStream = vi.fn(() => ttyOutput);
    const createInterface = vi.fn(() => ({
      question: (_question: string, callback: (answer: string) => void) => {
        callback("q");
      },
      close: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    }));

    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        openSync,
        createReadStream,
        createWriteStream,
      };
    });
    vi.doMock("node:readline", () => ({ createInterface }));
    vi.doMock("./core/config.js", () => ({
      AGENT_NAMES: TEST_AGENT_NAMES,
      isAgentSpec: TEST_IS_AGENT_SPEC,
      loadConfig: vi.fn(() => ({
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        acpRegistryOverrides: {},
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
      peekRunMetadata: vi.fn(() => ({
        ...stubRunInfo,
        runId: "existing-run",
        promptPath,
      })),
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
    const originalIsTTY = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });

    try {
      await expect(import("./cli.js")).rejects.toThrow(
        /process\.exit unexpectedly called with 1/,
      );

      expect(openSync).toHaveBeenCalledTimes(2);
      expect(openSync).toHaveBeenNthCalledWith(1, inputPath, "r");
      expect(openSync).toHaveBeenNthCalledWith(2, outputPath, "w");
      expect(createReadStream).toHaveBeenCalledWith("", {
        autoClose: true,
        fd: inputFd,
      });
      expect(createWriteStream).toHaveBeenCalledWith("", {
        autoClose: true,
        fd: outputFd,
      });
      expect(createInterface).toHaveBeenCalledWith({
        input: ttyInput,
        output: ttyOutput,
      });
      expect(startSleepPrevention).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenNthCalledWith(1, 0);
      expect(exitSpy).toHaveBeenNthCalledWith(2, 1);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("process.exit unexpectedly called with 0"),
      );
    } finally {
      process.argv = originalArgv;
      if (originalIsTTY) {
        Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
      }
      stdoutWrite.mockRestore();
      consoleError.mockRestore();
      exitSpy.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails cleanly when no controlling terminal is available for the overwrite prompt", async () => {
    const inputPath = process.platform === "win32" ? "CONIN$" : "/dev/tty";
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
    const openSync = vi.fn(() => {
      throw new Error("tty unavailable");
    });

    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        openSync,
      };
    });
    vi.doMock("./core/config.js", () => ({
      AGENT_NAMES: TEST_AGENT_NAMES,
      isAgentSpec: TEST_IS_AGENT_SPEC,
      loadConfig: vi.fn(() => ({
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        acpRegistryOverrides: {},
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
      peekRunMetadata: vi.fn(() => ({
        ...stubRunInfo,
        runId: "existing-run",
        promptPath,
      })),
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
    const originalIsTTY = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });

    try {
      const result = await importCliExpectError();

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(
        /process\.exit unexpectedly called with 1/,
      );
      expect(openSync).toHaveBeenCalledWith(inputPath, "r");
      expect(startSleepPrevention).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "Cannot show the overwrite prompt because stdin is not interactive.",
        ),
      );
    } finally {
      process.argv = originalArgv;
      if (originalIsTTY) {
        Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
      }
      stdoutWrite.mockRestore();
      consoleError.mockRestore();
      exitSpy.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the SIGINT exit code when the overwrite prompt is interrupted", async () => {
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
    let sigintListener: (() => void) | undefined;
    const readlineInterface = {
      question: vi.fn(() => {
        sigintListener?.();
      }),
      close: vi.fn(),
      once: vi.fn((event: string, listener: () => void) => {
        if (event === "SIGINT") {
          sigintListener = listener;
        }
        return readlineInterface;
      }),
      off: vi.fn(() => readlineInterface),
    };

    vi.resetModules();
    vi.doMock("node:readline", () => ({
      createInterface: vi.fn(() => readlineInterface),
    }));
    vi.doMock("./core/config.js", () => ({
      AGENT_NAMES: TEST_AGENT_NAMES,
      isAgentSpec: TEST_IS_AGENT_SPEC,
      loadConfig: vi.fn(() => ({
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        acpRegistryOverrides: {},
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
      peekRunMetadata: vi.fn(() => ({
        ...stubRunInfo,
        runId: "existing-run",
        promptPath,
      })),
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
    const originalIsTTY = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });

    try {
      const result = await importCliExpectError();

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(
        /process\.exit unexpectedly called with 130/,
      );
      expect(startSleepPrevention).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(130);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
      if (originalIsTTY) {
        Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
      }
      stdoutWrite.mockRestore();
      consoleError.mockRestore();
      exitSpy.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails cleanly when the overwrite prompt closes before an answer", async () => {
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
    let closeListener: (() => void) | undefined;
    const readlineInterface = {
      question: vi.fn(() => {
        closeListener?.();
      }),
      close: vi.fn(),
      once: vi.fn((event: string, listener: () => void) => {
        if (event === "close") {
          closeListener = listener;
        }
        return readlineInterface;
      }),
      off: vi.fn(() => readlineInterface),
    };

    vi.resetModules();
    vi.doMock("node:readline", () => ({
      createInterface: vi.fn(() => readlineInterface),
    }));
    vi.doMock("./core/config.js", () => ({
      AGENT_NAMES: TEST_AGENT_NAMES,
      isAgentSpec: TEST_IS_AGENT_SPEC,
      loadConfig: vi.fn(() => ({
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        acpRegistryOverrides: {},
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
      peekRunMetadata: vi.fn(() => ({
        ...stubRunInfo,
        runId: "existing-run",
        promptPath,
      })),
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
    const originalIsTTY = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });

    try {
      const result = await importCliExpectError();

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(
        /process\.exit unexpectedly called with 1/,
      );
      expect(startSleepPrevention).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "The overwrite prompt closed before a choice was entered.",
        ),
      );
    } finally {
      process.argv = originalArgv;
      if (originalIsTTY) {
        Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
      }
      stdoutWrite.mockRestore();
      consoleError.mockRestore();
      exitSpy.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
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
        once: vi.fn(),
        off: vi.fn(),
      })),
    }));
    vi.doMock("./core/config.js", () => ({
      AGENT_NAMES: TEST_AGENT_NAMES,
      isAgentSpec: TEST_IS_AGENT_SPEC,
      loadConfig: vi.fn(() => ({
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        acpRegistryOverrides: {},
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
      peekRunMetadata: vi.fn(() => ({
        ...stubRunInfo,
        runId: "existing-run",
        promptPath,
      })),
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
    const originalIsTTY = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });

    try {
      await expect(import("./cli.js")).rejects.toThrow(
        /process\.exit unexpectedly called with 1/,
      );

      expect(startSleepPrevention).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenNthCalledWith(1, 0);
      expect(exitSpy).toHaveBeenNthCalledWith(2, 1);
    } finally {
      process.argv = originalArgv;
      if (originalIsTTY) {
        Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
      }
      stdoutWrite.mockRestore();
      consoleError.mockRestore();
      exitSpy.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("continues from the last iteration when updating the prompt on an existing gnhf branch", async () => {
    const originalArgv = [...process.argv];
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const tempDir = mkdtempSync(join(tmpdir(), "gnhf-cli-test-"));
    const promptPath = join(tempDir, "PROMPT.md");
    const orchestratorCtor = vi.fn();
    const setupRun = vi.fn(() => stubRunInfo);
    const peekRunMetadata = vi.fn(() => ({
      ...stubRunInfo,
      runId: "existing-run",
      promptPath,
    }));
    const resumeRun = vi.fn(() => ({
      ...stubRunInfo,
      runId: "existing-run",
      promptPath,
    }));

    writeFileSync(promptPath, "existing prompt", "utf-8");

    vi.resetModules();
    vi.doMock("node:readline", () => ({
      createInterface: vi.fn(() => ({
        question: (_question: string, callback: (answer: string) => void) => {
          callback("o");
        },
        close: vi.fn(),
        once: vi.fn(),
        off: vi.fn(),
      })),
    }));
    vi.doMock("./core/config.js", () => ({
      AGENT_NAMES: TEST_AGENT_NAMES,
      isAgentSpec: TEST_IS_AGENT_SPEC,
      loadConfig: vi.fn(() => ({
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        acpRegistryOverrides: {},
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
      setupRun,
      peekRunMetadata,
      resumeRun,
      getLastIterationNumber: vi.fn(() => 3),
    }));
    vi.doMock("./core/agents/factory.js", () => ({
      createAgent: vi.fn(() => ({ name: "claude" })),
    }));
    vi.doMock("./core/sleep.js", () => ({
      startSleepPrevention: vi.fn(),
    }));
    vi.doMock("./core/orchestrator.js", () => ({
      Orchestrator: class MockOrchestrator {
        constructor(...args: unknown[]) {
          orchestratorCtor(...args);
        }
        start = vi.fn(() => Promise.resolve());
        stop = vi.fn();
        on = vi.fn();
        getState = vi.fn(() => ({
          status: "completed" as const,
          currentIteration: 3,
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

    process.argv = ["node", "gnhf", "new prompt"];
    const originalIsTTY = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });

    try {
      await import("./cli.js");

      expect(peekRunMetadata).toHaveBeenCalledWith(
        "existing-run",
        process.cwd(),
      );
      expect(resumeRun).toHaveBeenCalledTimes(1);
      expect(resumeRun).toHaveBeenCalledWith("existing-run", process.cwd(), {
        includeStopField: false,
      });
      expect(setupRun).toHaveBeenCalledWith(
        "existing-run",
        "new prompt",
        "abc123",
        process.cwd(),
        { includeStopField: false },
      );
      expect(orchestratorCtor).toHaveBeenCalledTimes(1);
      expect(orchestratorCtor.mock.calls[0]?.[5]).toBe(3);
    } finally {
      process.argv = originalArgv;
      if (originalIsTTY) {
        Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
      }
      stdoutWrite.mockRestore();
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
        acpRegistryOverrides: {},
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
      AGENT_NAMES: TEST_AGENT_NAMES,
      isAgentSpec: TEST_IS_AGENT_SPEC,
      loadConfig: vi.fn(() => ({
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        acpRegistryOverrides: {},
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
      peekRunMetadata: vi.fn(() => stubRunInfo),
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

  it("uses the first SIGINT to request graceful shutdown", async () => {
    const { exitSpy, orchestratorStop, orchestratorRequestGracefulStop } =
      await runSigintCliTest({ forceOnSecondSigint: false });

    expect(orchestratorRequestGracefulStop).toHaveBeenCalledTimes(1);
    expect(orchestratorStop).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(130);
    exitSpy.mockRestore();
  });

  it("keeps the aborted screen open when a graceful shutdown ends in abort", async () => {
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

    let resolveStart!: () => void;
    let resolveRendererExit!: (reason: "interrupted") => void;
    const rendererExitPromise = new Promise<"interrupted">((resolve) => {
      resolveRendererExit = resolve;
    });
    const state = {
      status: "running" as "running" | "aborted",
      gracefulStopRequested: false,
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
      lastMessage: null as string | null,
    };
    const rendererStop = vi.fn(() => {
      resolveRendererExit("interrupted");
    });
    const orchestratorHandleInterrupt = vi.fn(() => {
      state.gracefulStopRequested = true;
      return "request-graceful-stop" as const;
    });

    vi.resetModules();
    vi.doMock("./core/config.js", () => ({
      AGENT_NAMES: TEST_AGENT_NAMES,
      isAgentSpec: TEST_IS_AGENT_SPEC,
      loadConfig: vi.fn(() => ({
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        acpRegistryOverrides: {},
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
      peekRunMetadata: vi.fn(() => stubRunInfo),
      resumeRun: vi.fn(),
      getLastIterationNumber: vi.fn(() => 0),
    }));
    vi.doMock("./core/agents/factory.js", () => ({
      createAgent: vi.fn(() => ({ name: "claude" })),
    }));
    vi.doMock("./core/orchestrator.js", () => ({
      Orchestrator: class MockOrchestrator {
        start = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              resolveStart = resolve;
            }),
        );
        stop = vi.fn();
        requestGracefulStop = vi.fn();
        handleInterrupt = orchestratorHandleInterrupt;
        on = vi.fn();
        getState = vi.fn(() => state);
      },
    }));
    vi.doMock("./renderer.js", () => ({
      Renderer: class MockRenderer {
        start = vi.fn();
        stop = rendererStop;
        waitUntilExit = vi.fn(() => rendererExitPromise);
      },
    }));

    process.argv = ["node", "gnhf", "ship it"];

    try {
      const cliPromise = import("./cli.js");

      await vi.waitFor(() => {
        expect(signalHandlers.has("SIGINT")).toBe(true);
      });

      signalHandlers.get("SIGINT")?.();
      state.status = "aborted";
      state.lastMessage = "3 consecutive failures";
      resolveStart();

      await Promise.resolve();
      await Promise.resolve();

      expect(rendererStop).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();

      resolveRendererExit("interrupted");
      await cliPromise;

      expect(exitSpy).toHaveBeenCalledWith(130);
      expect(consoleError).toHaveBeenCalledWith(
        `\n  gnhf: Run log: ${stubRunInfo.logPath}\n`,
      );
    } finally {
      process.argv = originalArgv;
      stdoutWrite.mockRestore();
      consoleError.mockRestore();
      exitSpy.mockRestore();
      processOn.mockRestore();
      processOff.mockRestore();
    }
  });

  it("uses the second SIGINT to force shutdown", async () => {
    vi.useFakeTimers();
    const {
      exitSpy,
      orchestratorStop,
      orchestratorRequestGracefulStop,
      rendererStop,
    } = await runSigintCliTest({ forceOnSecondSigint: true });

    expect(orchestratorRequestGracefulStop).toHaveBeenCalledTimes(1);
    expect(rendererStop).toHaveBeenCalledTimes(1);
    expect(orchestratorStop).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(130);
    exitSpy.mockRestore();
  });

  it("prints the run log path after an abort", async () => {
    const { consoleErrorCalls } = await runCliWithMocks(
      ["ship it"],
      {
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        acpRegistryOverrides: {},
        maxConsecutiveFailures: 3,
        preventSleep: false,
      },
      {
        orchestratorGetState: vi.fn(() => ({
          status: "aborted" as const,
          gracefulStopRequested: false,
          interruptHint: "exit" as const,
          currentIteration: 1,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          commitCount: 0,
          iterations: [],
          successCount: 0,
          failCount: 1,
          consecutiveFailures: 1,
          consecutiveErrors: 0,
          startTime: new Date("2026-01-01T00:00:00Z"),
          waitingUntil: null,
          lastMessage: "claude credit balance too low - see gnhf.log",
          lastAgentError:
            "claude exited with code 1: Credit balance is too low",
        })),
      },
    );

    expect(consoleErrorCalls).toContainEqual([
      `\n  gnhf: Run log: ${stubRunInfo.logPath}\n`,
    ]);
  });

  it("forces shutdown on SIGINT when the completed run screen is already showing", async () => {
    const {
      exitSpy,
      orchestratorStop,
      orchestratorRequestGracefulStop,
      rendererStop,
    } = await runSigintCliTest({
      forceOnSecondSigint: false,
      initialStatus: "aborted",
    });

    expect(orchestratorRequestGracefulStop).not.toHaveBeenCalled();
    expect(rendererStop).toHaveBeenCalledTimes(1);
    expect(orchestratorStop).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(130);
    exitSpy.mockRestore();
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
      AGENT_NAMES: TEST_AGENT_NAMES,
      isAgentSpec: TEST_IS_AGENT_SPEC,
      loadConfig: vi.fn(() => ({
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        acpRegistryOverrides: {},
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
      peekRunMetadata: vi.fn(() => stubRunInfo),
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

  it("routes raw ctrl+c through the renderer into orchestrator interrupt handling", async () => {
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

    let dataHandler: ((data: Buffer) => void) | null = null;
    const originalIsTTY = process.stdin.isTTY;
    const originalSetRawMode = (
      process.stdin as NodeJS.ReadStream & {
        setRawMode?: (mode: boolean) => void;
      }
    ).setRawMode;
    const originalResume = process.stdin.resume;
    const originalPause = process.stdin.pause;
    const originalOn = process.stdin.on;
    const originalRemoveAllListeners = process.stdin.removeAllListeners;

    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdin, "setRawMode", {
      configurable: true,
      value: vi.fn(() => process.stdin),
    });
    process.stdin.resume = vi.fn();
    process.stdin.pause = vi.fn();
    process.stdin.on = vi.fn(
      (event: string, handler: (...args: unknown[]) => void) => {
        if (event === "data") {
          dataHandler = handler as (data: Buffer) => void;
        }
        return process.stdin;
      },
    ) as typeof process.stdin.on;
    process.stdin.removeAllListeners = vi.fn(() => process.stdin);

    const state: {
      status: "running" | "stopped";
      gracefulStopRequested: boolean;
      interruptHint: "resume" | "force-stop";
      currentIteration: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      commitCount: number;
      iterations: never[];
      successCount: number;
      failCount: number;
      consecutiveFailures: number;
      startTime: Date;
      waitingUntil: null;
      lastMessage: null;
    } = {
      status: "running",
      gracefulStopRequested: false,
      interruptHint: "resume",
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
    };
    let resolveStart!: () => void;
    const orchestratorRequestGracefulStop = vi.fn();
    const orchestratorStop = vi.fn();
    const orchestratorHandleInterrupt = vi.fn();

    vi.resetModules();
    vi.doMock("./core/config.js", () => ({
      AGENT_NAMES: TEST_AGENT_NAMES,
      isAgentSpec: TEST_IS_AGENT_SPEC,
      loadConfig: vi.fn(() => ({
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        acpRegistryOverrides: {},
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
      peekRunMetadata: vi.fn(() => stubRunInfo),
      resumeRun: vi.fn(),
      getLastIterationNumber: vi.fn(() => 0),
    }));
    vi.doMock("./core/agents/factory.js", () => ({
      createAgent: vi.fn(() => ({ name: "claude" })),
    }));
    vi.doUnmock("./renderer.js");
    vi.doMock("./core/orchestrator.js", () => {
      return {
        Orchestrator: class MockOrchestrator extends EventEmitter {
          start = vi.fn(
            () =>
              new Promise<void>((resolve) => {
                resolveStart = resolve;
              }),
          );
          stop = vi.fn(() => {
            orchestratorStop();
            state.status = "stopped";
            state.interruptHint = "force-stop";
            this.emit("state", { ...state });
            resolveStart();
            this.emit("stopped");
          });
          requestGracefulStop = vi.fn(() => {
            orchestratorRequestGracefulStop();
            state.gracefulStopRequested = true;
            state.interruptHint = "force-stop";
            this.emit("state", { ...state });
          });
          handleInterrupt = vi.fn(() => {
            orchestratorHandleInterrupt();
            if (state.gracefulStopRequested || state.status === "stopped") {
              this.stop();
              return "force-stop" as const;
            }
            this.requestGracefulStop();
            return "request-graceful-stop" as const;
          });
          getState = vi.fn(() => ({ ...state }));
        },
      };
    });

    process.argv = ["node", "gnhf", "ship it"];

    try {
      const cliPromise = import("./cli.js");

      await vi.waitFor(() => {
        expect(dataHandler).not.toBeNull();
      });

      dataHandler!(Buffer.from([3]));
      expect(orchestratorRequestGracefulStop).toHaveBeenCalledTimes(1);

      dataHandler!(Buffer.from([3]));
      await cliPromise;

      expect(orchestratorHandleInterrupt).toHaveBeenCalledTimes(2);
      expect(orchestratorStop).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(130);
    } finally {
      process.argv = originalArgv;
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: originalIsTTY,
      });
      Object.defineProperty(process.stdin, "setRawMode", {
        configurable: true,
        value: originalSetRawMode,
      });
      process.stdin.resume = originalResume;
      process.stdin.pause = originalPause;
      process.stdin.on = originalOn;
      process.stdin.removeAllListeners = originalRemoveAllListeners;
      stdoutWrite.mockRestore();
      consoleError.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("suffixes new branch names when the generated branch already exists", async () => {
    const createBranch = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("fatal: a branch named already exists");
      })
      .mockImplementationOnce(() => {});

    await runCliWithMocks(
      ["ship it"],
      {
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        acpRegistryOverrides: {},
        maxConsecutiveFailures: 3,
        preventSleep: false,
      },
      { createBranch },
    );

    const firstBranch = createBranch.mock.calls[0]?.[0] as string;
    expect(createBranch).toHaveBeenCalledTimes(2);
    expect(createBranch.mock.calls[1]?.[0]).toBe(`${firstBranch}-1`);
  });

  it("suffixes worktree branch and path when the generated worktree collides", async () => {
    const createWorktree = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("fatal: already exists");
      })
      .mockImplementationOnce(() => {});

    await runCliWithMocks(
      ["ship it", "--worktree"],
      {
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        acpRegistryOverrides: {},
        maxConsecutiveFailures: 3,
        preventSleep: false,
      },
      { createWorktree },
    );

    const firstPath = createWorktree.mock.calls[0]?.[1] as string;
    const firstBranch = createWorktree.mock.calls[0]?.[2] as string;
    expect(createWorktree).toHaveBeenCalledTimes(2);
    expect(createWorktree.mock.calls[1]?.[1]).toBe(`${firstPath}-1`);
    expect(createWorktree.mock.calls[1]?.[2]).toBe(`${firstBranch}-1`);
  });

  it("queries git worktrees once when no preserved worktree exists", async () => {
    const listWorktreePaths = vi.fn(() => new Set());

    await runCliWithMocks(
      ["ship it", "--worktree"],
      {
        agent: "claude",
        agentPathOverride: {},
        agentArgsOverride: {},
        acpRegistryOverrides: {},
        maxConsecutiveFailures: 3,
        preventSleep: false,
      },
      { listWorktreePaths },
    );

    expect(listWorktreePaths).toHaveBeenCalledTimes(1);
  });

  it("resumes a preserved suffixed worktree instead of creating another one", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "gnhf-cli-worktree-resume-"));
    const repoRoot = join(tempDir, "repo");
    const hash = createHash("sha256")
      .update("ship it")
      .digest("hex")
      .slice(0, 6);
    const runId = `ship-it-${hash}`;
    const suffixedRunId = `${runId}-1`;
    const suffixedBranch = `gnhf/${suffixedRunId}`;
    const worktreeRoot = join(tempDir, "repo-gnhf-worktrees");
    const suffixedWorktreePath = join(worktreeRoot, suffixedRunId);
    mkdirSync(join(suffixedWorktreePath, ".gnhf", "runs", suffixedRunId), {
      recursive: true,
    });

    const createWorktree = vi.fn((_repo, path) => {
      if (path === join(worktreeRoot, runId)) {
        throw new Error("fatal: already exists");
      }
      throw new Error("should resume preserved suffixed worktree");
    });
    const resumeRun = vi.fn(() => ({
      ...stubRunInfo,
      runId: suffixedRunId,
      runDir: join(suffixedWorktreePath, ".gnhf", "runs", suffixedRunId),
    }));

    try {
      const { orchestratorCtor } = await runCliWithMocks(
        ["ship it", "--worktree"],
        {
          agent: "claude",
          agentPathOverride: {},
          agentArgsOverride: {},
          acpRegistryOverrides: {},
          maxConsecutiveFailures: 3,
          preventSleep: false,
        },
        {
          createWorktree,
          getRepoRootDir: vi.fn(() => repoRoot),
          getCurrentBranch: vi.fn((cwd: string) =>
            cwd === suffixedWorktreePath ? suffixedBranch : "main",
          ),
          listWorktreePaths: vi.fn(() => new Set([suffixedWorktreePath])),
          resumeRun,
        },
      );

      expect(resumeRun).toHaveBeenCalledWith(
        suffixedRunId,
        suffixedWorktreePath,
        { includeStopField: false },
      );
      expect(createWorktree).not.toHaveBeenCalled();
      expect(orchestratorCtor.mock.calls[0]?.[4]).toBe(suffixedWorktreePath);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("clears stop-when when resuming a preserved worktree with an empty value", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "gnhf-cli-worktree-resume-"));
    const repoRoot = join(tempDir, "repo");
    const hash = createHash("sha256")
      .update("ship it")
      .digest("hex")
      .slice(0, 6);
    const runId = `ship-it-${hash}`;
    const branch = `gnhf/${runId}`;
    const worktreeRoot = join(tempDir, "repo-gnhf-worktrees");
    const worktreePath = join(worktreeRoot, runId);
    mkdirSync(join(worktreePath, ".gnhf", "runs", runId), {
      recursive: true,
    });

    const resumeRun = vi.fn(() => ({
      ...stubRunInfo,
      runId,
      runDir: join(worktreePath, ".gnhf", "runs", runId),
      stopWhen: undefined,
    }));

    try {
      const { createAgent, orchestratorCtor } = await runCliWithMocks(
        ["ship it", "--worktree", "--stop-when", ""],
        {
          agent: "claude",
          agentPathOverride: {},
          agentArgsOverride: {},
          acpRegistryOverrides: {},
          maxConsecutiveFailures: 3,
          preventSleep: false,
        },
        {
          getRepoRootDir: vi.fn(() => repoRoot),
          getCurrentBranch: vi.fn((cwd: string) =>
            cwd === worktreePath ? branch : "main",
          ),
          listWorktreePaths: vi.fn(() => new Set([worktreePath])),
          resumeRun,
        },
      );

      expect(resumeRun).toHaveBeenCalledWith(runId, worktreePath, {
        includeStopField: false,
        clearStopWhen: true,
      });
      expect(createAgent.mock.calls[0]?.[4]).toEqual({
        includeStopField: false,
        acpRegistryOverrides: {},
      });
      expect(orchestratorCtor.mock.calls[0]?.[6]).toEqual({
        maxIterations: undefined,
        maxTokens: undefined,
        stopWhen: undefined,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("resumes a preserved suffixed worktree before creating an available unsuffixed one", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "gnhf-cli-worktree-resume-"));
    const repoRoot = join(tempDir, "repo");
    const hash = createHash("sha256")
      .update("ship it")
      .digest("hex")
      .slice(0, 6);
    const runId = `ship-it-${hash}`;
    const suffixedRunId = `${runId}-1`;
    const suffixedBranch = `gnhf/${suffixedRunId}`;
    const worktreeRoot = join(tempDir, "repo-gnhf-worktrees");
    const suffixedWorktreePath = join(worktreeRoot, suffixedRunId);
    mkdirSync(join(suffixedWorktreePath, ".gnhf", "runs", suffixedRunId), {
      recursive: true,
    });

    const createWorktree = vi.fn(() => {
      throw new Error("should resume preserved suffixed worktree");
    });
    const resumeRun = vi.fn(() => ({
      ...stubRunInfo,
      runId: suffixedRunId,
      runDir: join(suffixedWorktreePath, ".gnhf", "runs", suffixedRunId),
    }));

    try {
      const { orchestratorCtor } = await runCliWithMocks(
        ["ship it", "--worktree"],
        {
          agent: "claude",
          agentPathOverride: {},
          agentArgsOverride: {},
          acpRegistryOverrides: {},
          maxConsecutiveFailures: 3,
          preventSleep: false,
        },
        {
          createWorktree,
          getRepoRootDir: vi.fn(() => repoRoot),
          getCurrentBranch: vi.fn((cwd: string) =>
            cwd === suffixedWorktreePath ? suffixedBranch : "main",
          ),
          listWorktreePaths: vi.fn(() => new Set([suffixedWorktreePath])),
          resumeRun,
        },
      );

      expect(resumeRun).toHaveBeenCalledWith(
        suffixedRunId,
        suffixedWorktreePath,
        { includeStopField: false },
      );
      expect(createWorktree).not.toHaveBeenCalled();
      expect(orchestratorCtor.mock.calls[0]?.[4]).toBe(suffixedWorktreePath);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the persisted commit message convention when resuming a preserved worktree", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "gnhf-cli-worktree-resume-"));
    const repoRoot = join(tempDir, "repo");
    const hash = createHash("sha256")
      .update("ship it")
      .digest("hex")
      .slice(0, 6);
    const runId = `ship-it-${hash}`;
    const branch = `gnhf/${runId}`;
    const worktreeRoot = join(tempDir, "repo-gnhf-worktrees");
    const worktreePath = join(worktreeRoot, runId);
    mkdirSync(join(worktreePath, ".gnhf", "runs", runId), {
      recursive: true,
    });

    const resumeRun = vi.fn(() => ({
      ...stubRunInfo,
      runId,
      runDir: join(worktreePath, ".gnhf", "runs", runId),
      commitMessage: undefined,
    }));

    try {
      const { createAgent, orchestratorCtor } = await runCliWithMocks(
        ["ship it", "--worktree"],
        {
          agent: "claude",
          agentPathOverride: {},
          agentArgsOverride: {},
          acpRegistryOverrides: {},
          maxConsecutiveFailures: 3,
          preventSleep: false,
          commitMessage: CONVENTIONAL_COMMIT_MESSAGE,
        },
        {
          getRepoRootDir: vi.fn(() => repoRoot),
          getCurrentBranch: vi.fn((cwd: string) =>
            cwd === worktreePath ? branch : "main",
          ),
          listWorktreePaths: vi.fn(() => new Set([worktreePath])),
          resumeRun,
        },
      );

      expect(createAgent.mock.calls[0]?.[4]).toEqual({
        includeStopField: false,
        acpRegistryOverrides: {},
      });
      expect(orchestratorCtor.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ commitMessage: undefined }),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
