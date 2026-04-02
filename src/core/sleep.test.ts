import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { startSleepPrevention } from "./sleep.js";

const mockSpawn = vi.mocked(spawn);

function createChildProcess(pid = 1234): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    pid,
    kill: vi.fn((signal?: NodeJS.Signals) => {
      child.emit("close", signal === "SIGKILL" ? 1 : 0, null);
      return true;
    }),
  });
  return child as unknown as ChildProcess;
}

describe("startSleepPrevention", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("starts caffeinate on macOS and returns a cleanup handle", async () => {
    const child = createChildProcess();
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child as never;
    });

    const result = await startSleepPrevention(["ship it"], {
      pid: 42,
      platform: "darwin",
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      "caffeinate",
      ["-i", "-w", "42"],
      expect.objectContaining({ stdio: "ignore" }),
    );
    expect(result.type).toBe("active");
    if (result.type === "active") {
      await result.cleanup();
    }
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("re-execs under systemd-inhibit on Linux", async () => {
    const child = createChildProcess();
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => {
        child.emit("spawn");
        child.emit("exit", 0, null);
      });
      return child as never;
    });

    const result = await startSleepPrevention(
      ["ship it", "--agent", "opencode"],
      {
        env: {},
        platform: "linux",
        processArgv1: "/dist/cli.mjs",
        processExecPath: "/node",
      },
    );

    expect(mockSpawn).toHaveBeenCalledWith(
      "systemd-inhibit",
      expect.arrayContaining([
        "--what=idle:sleep",
        "--mode=block",
        "/node",
        "/dist/cli.mjs",
        "ship it",
        "--agent",
        "opencode",
      ]),
      expect.objectContaining({
        stdio: "inherit",
        env: expect.objectContaining({ GNHF_SLEEP_INHIBITED: "1" }),
      }),
    );
    expect(result).toEqual({ type: "reexeced", exitCode: 0 });
  });

  it("starts a PowerShell helper on Windows", async () => {
    const child = createChildProcess();
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child as never;
    });

    const result = await startSleepPrevention(["ship it"], {
      pid: 42,
      platform: "win32",
    });

    expect(mockSpawn.mock.calls[0]?.[0]).toBe("powershell.exe");
    expect(mockSpawn.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
      ]),
    );
    expect(String(mockSpawn.mock.calls[0]?.[1]?.at(-1))).toContain(
      "SetThreadExecutionState",
    );
    expect(String(mockSpawn.mock.calls[0]?.[1]?.at(-1))).toContain("42");
    expect(result.type).toBe("active");
  });
});
