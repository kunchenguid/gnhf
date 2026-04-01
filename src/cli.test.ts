import { readFileSync } from "node:fs";
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
  baseCommit: "abc123",
  baseCommitPath: "/repo/.gnhf/runs/run-abc/base-commit",
};

interface CliMockOverrides {
  orchestratorStart?: ReturnType<typeof vi.fn>;
  rendererWaitUntilExit?: ReturnType<typeof vi.fn>;
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
  const createAgent = vi.fn(() => ({ name: config.agent }));

  const orchestratorStart =
    overrides.orchestratorStart ?? vi.fn(() => Promise.resolve());
  const orchestratorStop = vi.fn();
  const orchestratorOn = vi.fn();
  const orchestratorGetState = vi.fn(() => ({
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
  const rendererStop = vi.fn();
  const rendererWaitUntilExit =
    overrides.rendererWaitUntilExit ?? vi.fn(() => Promise.resolve());
  const orchestratorCtor = vi.fn();

  vi.resetModules();
  vi.doMock("./core/config.js", () => ({ loadConfig }));
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
  vi.doMock("./core/agents/factory.js", () => ({ createAgent }));
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

  try {
    await import("./cli.js");
  } finally {
    process.argv = originalArgv;
    stdoutWrite.mockRestore();
    exitSpy.mockRestore();
  }

  return { loadConfig, createAgent, orchestratorCtor };
}

describe("cli", () => {
  it("prints the package version for -V", async () => {
    const originalArgv = [...process.argv];
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as typeof process.exit);

    process.argv = ["node", "gnhf", "-V"];

    try {
      vi.resetModules();
      await import("./cli.js");

      expect(stdoutWrite).toHaveBeenCalledWith(`${packageVersion}\n`);
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      process.argv = originalArgv;
      stdoutWrite.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("uses config.agent when --agent is not passed", async () => {
    const { loadConfig, createAgent } = await runCliWithMocks(["ship it"], {
      agent: "codex",
      maxConsecutiveFailures: 3,
    });

    expect(loadConfig).toHaveBeenCalledWith(undefined);
    expect(createAgent).toHaveBeenCalledWith("codex", stubRunInfo);
  });

  it("uses the explicit --agent flag as an override", async () => {
    const { loadConfig, createAgent } = await runCliWithMocks(
      ["ship it", "--agent", "claude"],
      {
        agent: "claude",
        maxConsecutiveFailures: 3,
      },
    );

    expect(loadConfig).toHaveBeenCalledWith({ agent: "claude" });
    expect(createAgent).toHaveBeenCalledWith("claude", stubRunInfo);
  });

  it("accepts rovodev as an explicit --agent override", async () => {
    const { loadConfig, createAgent } = await runCliWithMocks(
      ["ship it", "--agent", "rovodev"],
      {
        agent: "rovodev",
        maxConsecutiveFailures: 3,
      },
    );

    expect(loadConfig).toHaveBeenCalledWith({ agent: "rovodev" });
    expect(createAgent).toHaveBeenCalledWith("rovodev", stubRunInfo);
  });

  it("passes max iteration and token caps to the orchestrator", async () => {
    const { orchestratorCtor } = await runCliWithMocks(
      ["ship it", "--max-iterations", "12", "--max-tokens", "3456"],
      {
        agent: "claude",
        maxConsecutiveFailures: 3,
      },
    );

    expect(orchestratorCtor).toHaveBeenCalledTimes(1);
    expect(orchestratorCtor.mock.calls[0]?.[6]).toEqual({
      maxIterations: 12,
      maxTokens: 3456,
    });
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
        maxConsecutiveFailures: 3,
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
        maxConsecutiveFailures: 3,
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
});
