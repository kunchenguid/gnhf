// Disk-guard tests for the orchestrator (issue #252): the guard stops the
// loop BEFORE starting a new iteration when the run filesystem is low, warns
// on the way down, and fails open on a statfs error. Method-level tests via
// the injectable statfs seam — no agent, no git, no filesystem needed.
import { describe, expect, it, vi } from "vitest";

vi.mock("./git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git.js")>();
  return {
    ...actual,
    commitAll: vi.fn(),
    getBranchCommitCount: vi.fn(() => 0),
    getCurrentBranch: vi.fn(() => "gnhf/run-abc"),
    getHeadCommit: vi.fn(() => "head123"),
    pushCurrentBranch: vi.fn(),
    resetHard: vi.fn(),
  };
});

vi.mock("./debug-log.js", () => ({
  appendDebugLog: vi.fn(),
  initDebugLog: vi.fn(),
  serializeError: vi.fn((err: unknown) => ({
    name: err instanceof Error ? err.name : "unknown",
    message: err instanceof Error ? err.message : String(err),
  })),
}));

import { Orchestrator } from "./orchestrator.js";
import type { Config } from "./config.js";
import type { RunInfo } from "./run.js";
import type { StatfsFn } from "./disk.js";

const MB = 1024 * 1024;

const config = {
  agent: "claude",
  agentModel: {},
  agentPathOverride: {},
  agentArgsOverride: {},
  acpRegistryOverrides: {},
  maxConsecutiveFailures: 3,
  minDiskFreeMb: 256,
  preventSleep: true,
} as unknown as Config;

const runInfo = {
  runId: "run-abc",
  runDir: "/tmp/run-abc",
  promptPath: "",
  notesPath: "",
  schemaPath: "",
  logPath: "",
  baseCommit: "head123",
  baseCommitPath: "",
  stopWhenPath: "",
  stopWhen: undefined,
  commitMessagePath: "",
  commitMessage: undefined,
} as unknown as RunInfo;

function makeOrchestrator(statfsFn: StatfsFn, minFreeBytes?: number) {
  return new Orchestrator(
    config,
    {} as never, // never reached: these tests drive getDiskAbortReason only
    runInfo,
    "objective",
    "/tmp/repo",
    0,
    minFreeBytes === undefined ? {} : { minFreeDiskBytes: minFreeBytes },
    { statfsFn },
  );
}

describe("orchestrator disk guard", () => {
  it("is a no-op when minFreeDiskBytes is unset or 0", async () => {
    const orch = makeOrchestrator(() =>
      Promise.resolve({ freeBytes: 0, totalBytes: 0 }),
    );
    await expect(
      (orch as unknown as { getDiskAbortReason(): Promise<string | null> })
        .getDiskAbortReason(),
    ).resolves.toBeNull();
    const disabled = makeOrchestrator(
      () => Promise.resolve({ freeBytes: 0, totalBytes: 0 }),
      0,
    );
    await expect(
      (disabled as unknown as { getDiskAbortReason(): Promise<string | null> })
        .getDiskAbortReason(),
    ).resolves.toBeNull();
  });

  it("aborts before the next iteration when free space is below the minimum", async () => {
    const orch = makeOrchestrator(
      () => Promise.resolve({ freeBytes: 99 * MB, totalBytes: 1024 * MB }),
      100 * MB,
    );
    const reason = await (
      orch as unknown as { getDiskAbortReason(): Promise<string | null> }
    ).getDiskAbortReason();
    expect(reason).toContain("temp disk low");
    expect(reason).toContain("99 MB");
    expect(reason).toContain("--min-disk-free-mb");
    expect(orch.getState().diskFreeBytes).toBe(99 * MB);
  });

  it("returns no abort at the warn band but records the reading", async () => {
    const orch = makeOrchestrator(
      () => Promise.resolve({ freeBytes: 150 * MB, totalBytes: 1024 * MB }),
      100 * MB,
    );
    const reason = await (
      orch as unknown as { getDiskAbortReason(): Promise<string | null> }
    ).getDiskAbortReason();
    expect(reason).toBeNull();
    expect(orch.getState().diskFreeBytes).toBe(150 * MB);
  });

  it("fails open when statfs errors (a probe failure is not ENOSPC)", async () => {
    const orch = makeOrchestrator(
      () => Promise.reject(new Error("statfs boom")),
      100 * MB,
    );
    const reason = await (
      orch as unknown as { getDiskAbortReason(): Promise<string | null> }
    ).getDiskAbortReason();
    expect(reason).toBeNull();
    expect(orch.getState().diskFreeBytes).toBeUndefined();
  });

  it("clears without abort when free space is healthy", async () => {
    const orch = makeOrchestrator(
      () => Promise.resolve({ freeBytes: 500 * MB, totalBytes: 1024 * MB }),
      100 * MB,
    );
    const reason = await (
      orch as unknown as { getDiskAbortReason(): Promise<string | null> }
    ).getDiskAbortReason();
    expect(reason).toBeNull();
    expect(orch.getState().diskFreeBytes).toBe(500 * MB);
  });
});
