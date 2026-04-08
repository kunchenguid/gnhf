import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { startSleepPrevention } from "./sleep.js";

const mockSpawn = vi.mocked(spawn);

function createChildProcess(pid = 1234): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    pid,
    kill: vi.fn((signal?: number | NodeJS.Signals) => {
      child.emit("close", signal === "SIGKILL" ? 1 : 0, null);
      return true as const;
    }),
    signalCode: null,
  });
  return child as unknown as ChildProcess;
}

describe("startSleepPrevention", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
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

  it("falls back when a helper exits immediately after spawn", async () => {
    vi.useFakeTimers();

    const child = createChildProcess();
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => {
        child.emit("spawn");
        setTimeout(() => {
          child.emit("exit", 1, null);
        }, 50);
      });
      return child as never;
    });

    const resultPromise = startSleepPrevention(["ship it"], {
      pid: 42,
      platform: "darwin",
    });

    await vi.advanceTimersByTimeAsync(50);

    await expect(resultPromise).resolves.toEqual({
      type: "skipped",
      reason: "unavailable",
    });
  });

  it("falls back when a helper has already exited by the time stability checking starts", async () => {
    vi.useFakeTimers();

    const child = createChildProcess();
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => {
        child.emit("spawn");
        Object.defineProperty(child, "exitCode", {
          configurable: true,
          value: 1,
        });
      });
      return child as never;
    });

    const resultPromise = startSleepPrevention(["ship it"], {
      pid: 42,
      platform: "darwin",
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);

    await expect(resultPromise).resolves.toEqual({
      type: "skipped",
      reason: "unavailable",
    });
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
        detached: true,
        stdio: "inherit",
        env: expect.objectContaining({ GNHF_SLEEP_INHIBITED: "1" }),
      }),
    );
    expect(result).toEqual({ type: "reexeced", exitCode: 0 });
  });

  it("preserves process.execArgv when re-execing under systemd-inhibit on Linux", async () => {
    const child = createChildProcess();
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => {
        child.emit("spawn");
        child.emit("exit", 0, null);
      });
      return child as never;
    });

    const result = await startSleepPrevention(["ship it"], {
      env: {},
      platform: "linux",
      processArgv1: "/dist/cli.mjs",
      processExecPath: "/node",
      processExecArgv: ["--inspect", "--loader", "tsx"],
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      "systemd-inhibit",
      expect.arrayContaining([
        "--what=idle:sleep",
        "--mode=block",
        "/node",
        "--inspect",
        "--loader",
        "tsx",
        "/dist/cli.mjs",
        "ship it",
      ]),
      expect.any(Object),
    );
    expect(result).toEqual({ type: "reexeced", exitCode: 0 });
  });

  it("preserves re-exec environment overrides when re-execing under systemd-inhibit on Linux", async () => {
    const child = createChildProcess();
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => {
        child.emit("spawn");
        child.emit("exit", 0, null);
      });
      return child as never;
    });

    const result = await startSleepPrevention(["--agent", "opencode"], {
      env: {},
      platform: "linux",
      processArgv1: "/dist/cli.mjs",
      processExecPath: "/node",
      reexecEnv: {
        GNHF_REEXEC_STDIN_PROMPT: "objective from stdin",
      },
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      "systemd-inhibit",
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          GNHF_REEXEC_STDIN_PROMPT: "objective from stdin",
          GNHF_SLEEP_INHIBITED: "1",
        }),
      }),
    );
    expect(result).toEqual({ type: "reexeced", exitCode: 0 });
  });

  it("falls back when systemd-inhibit exits immediately with an error", async () => {
    const child = createChildProcess();
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => {
        child.emit("spawn");
        child.emit("exit", 1, null);
      });
      return child as never;
    });

    const result = await startSleepPrevention(["ship it"], {
      env: {},
      platform: "linux",
      processArgv1: "/dist/cli.mjs",
      processExecPath: "/node",
    });

    expect(result).toEqual({ type: "skipped", reason: "unavailable" });
  });

  it("signals readiness when running inside the re-execed Linux process", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "gnhf-sleep-"));
    const readyPath = join(tempDir, "reexec-ready");

    try {
      const result = await startSleepPrevention(["ship it"], {
        env: {
          GNHF_SLEEP_INHIBITED: "1",
          GNHF_SLEEP_REEXEC_READY_PATH: readyPath,
        },
        platform: "linux",
      });

      expect(result).toEqual({ type: "skipped", reason: "already-inhibited" });
      expect(existsSync(readyPath)).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not overwrite an untrusted readiness path from the environment", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "gnhf-sleep-test-"));
    const victimPath = join(tempDir, "victim.txt");
    writeFileSync(victimPath, "do not touch", "utf-8");

    try {
      const result = await startSleepPrevention(["ship it"], {
        env: {
          GNHF_SLEEP_INHIBITED: "1",
          GNHF_SLEEP_REEXEC_READY_PATH: victimPath,
        },
        platform: "linux",
      });

      expect(result).toEqual({ type: "skipped", reason: "already-inhibited" });
      expect(readFileSync(victimPath, "utf-8")).toBe("do not touch");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back when systemd-inhibit exits before the re-execed child signals readiness", async () => {
    vi.useFakeTimers();

    const child = createChildProcess();
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => {
        child.emit("spawn");
        setTimeout(() => {
          child.emit("exit", 1, null);
        }, 500);
      });
      return child as never;
    });

    const resultPromise = startSleepPrevention(["ship it"], {
      env: {},
      platform: "linux",
      processArgv1: "/dist/cli.mjs",
      processExecPath: "/node",
    });

    await vi.advanceTimersByTimeAsync(500);

    await expect(resultPromise).resolves.toEqual({
      type: "skipped",
      reason: "unavailable",
    });
  });

  it("treats the Linux re-exec as authoritative after the child signals readiness", async () => {
    vi.useFakeTimers();

    const child = createChildProcess();
    mockSpawn.mockImplementation((_, __, options) => {
      const readyPath = options?.env?.GNHF_SLEEP_REEXEC_READY_PATH;

      expect(readyPath).toEqual(expect.any(String));

      queueMicrotask(() => {
        child.emit("spawn");
        setTimeout(() => {
          if (typeof readyPath === "string") {
            writeFileSync(readyPath, "ready\n", "utf-8");
          }
        }, 300);
        setTimeout(() => {
          child.emit("exit", 1, null);
        }, 600);
      });
      return child as never;
    });

    const resultPromise = startSleepPrevention(["ship it"], {
      env: {},
      platform: "linux",
      processArgv1: "/dist/cli.mjs",
      processExecPath: "/node",
    });

    await vi.advanceTimersByTimeAsync(600);

    await expect(resultPromise).resolves.toEqual({
      type: "reexeced",
      exitCode: 1,
    });
  });

  it("treats the Linux re-exec as authoritative when the ready file appears just before a nonzero exit", async () => {
    vi.useFakeTimers();

    const child = createChildProcess();
    mockSpawn.mockImplementation((_, __, options) => {
      const readyPath = options?.env?.GNHF_SLEEP_REEXEC_READY_PATH;

      expect(readyPath).toEqual(expect.any(String));

      queueMicrotask(() => {
        child.emit("spawn");
        setTimeout(() => {
          if (typeof readyPath === "string") {
            writeFileSync(readyPath, "ready\n", "utf-8");
          }
        }, 301);
        setTimeout(() => {
          child.emit("exit", 1, null);
        }, 302);
      });
      return child as never;
    });

    const resultPromise = startSleepPrevention(["ship it"], {
      env: {},
      platform: "linux",
      processArgv1: "/dist/cli.mjs",
      processExecPath: "/node",
    });

    await vi.advanceTimersByTimeAsync(302);

    await expect(resultPromise).resolves.toEqual({
      type: "reexeced",
      exitCode: 1,
    });
  });

  it("forwards SIGTERM to systemd-inhibit while waiting for the re-execed child to exit", async () => {
    vi.useFakeTimers();

    const child = createChildProcess();
    const killProcess: typeof process.kill = vi.fn(() => true as const);
    let handleSigTerm: (() => void) | undefined;
    const processOn = vi.fn((event: string, listener: () => void) => {
      if (event === "SIGTERM") handleSigTerm = listener;
      return process;
    });
    const processOff = vi.fn(() => process);
    mockSpawn.mockImplementation((_, __, options) => {
      const readyPath = options?.env?.GNHF_SLEEP_REEXEC_READY_PATH;

      queueMicrotask(() => {
        child.emit("spawn");
        setTimeout(() => {
          if (typeof readyPath === "string") {
            writeFileSync(readyPath, "ready\n", "utf-8");
          }
        }, 100);
      });
      return child as never;
    });

    const resultPromise = startSleepPrevention(["ship it"], {
      env: {},
      platform: "linux",
      processArgv1: "/dist/cli.mjs",
      processExecPath: "/node",
      killProcess,
      processOn,
      processOff,
    });

    await vi.advanceTimersByTimeAsync(100);
    handleSigTerm?.();
    child.emit("exit", null, "SIGTERM");

    await expect(resultPromise).resolves.toEqual({
      type: "reexeced",
      exitCode: 143,
    });
    expect(killProcess).toHaveBeenCalledWith(-1234, "SIGTERM");
    expect(processOff).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
  });

  it("forwards signals received before waitForSpawn resolves", async () => {
    const child = createChildProcess();
    const killProcess: typeof process.kill = vi.fn(() => true as const);
    let handleSigInt: (() => void) | undefined;
    const processOn = vi.fn((event: string, listener: () => void) => {
      if (event === "SIGINT") handleSigInt = listener;
      return process;
    });
    const processOff = vi.fn(() => process);
    mockSpawn.mockImplementation(() => {
      // Simulate SIGINT arriving *before* the spawn event fires.
      queueMicrotask(() => {
        handleSigInt?.();
        child.emit("spawn");
        child.emit("exit", null, "SIGINT");
      });
      return child as never;
    });

    const result = await startSleepPrevention(["ship it"], {
      env: {},
      platform: "linux",
      processArgv1: "/dist/cli.mjs",
      processExecPath: "/node",
      killProcess,
      processOn,
      processOff,
    });

    expect(result).toEqual({ type: "reexeced", exitCode: 130 });
    expect(killProcess).toHaveBeenCalledWith(-1234, "SIGINT");
    expect(processOff).toHaveBeenCalledWith("SIGINT", expect.any(Function));
  });

  it("tears down signal forwarding when spawn fails", async () => {
    const child = createChildProcess();
    const processOn = vi.fn(() => process);
    const processOff = vi.fn(() => process);
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => {
        child.emit("error", new Error("spawn failed"));
      });
      return child as never;
    });

    const result = await startSleepPrevention(["ship it"], {
      env: {},
      platform: "linux",
      processArgv1: "/dist/cli.mjs",
      processExecPath: "/node",
      processOn,
      processOff,
    });

    expect(result).toEqual({ type: "skipped", reason: "unavailable" });
    expect(processOn).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processOn).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(processOff).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processOff).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
  });

  it("shuts down the Linux re-exec process group before falling back after a readiness timeout", async () => {
    vi.useFakeTimers();

    const child = createChildProcess();
    const killProcess: typeof process.kill = vi.fn(
      (pid: number, signal?: string | number) => {
        if (pid === -1234 && signal === "SIGTERM") {
          queueMicrotask(() => {
            child.emit("close", 0, null);
          });
        }
        return true as const;
      },
    );
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => {
        child.emit("spawn");
      });
      return child as never;
    });

    const resultPromise = startSleepPrevention(["ship it"], {
      env: {},
      killProcess,
      platform: "linux",
      processArgv1: "/dist/cli.mjs",
      processExecPath: "/node",
    });

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(resultPromise).resolves.toEqual({
      type: "skipped",
      reason: "unavailable",
    });
    expect(killProcess).toHaveBeenCalledWith(-1234, "SIGTERM");
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
    expect(String(mockSpawn.mock.calls[0]?.[1]?.at(-1))).toContain(
      "Add-Type @'\n",
    );
    expect(String(mockSpawn.mock.calls[0]?.[1]?.at(-1))).toContain("\n'@;");
    expect(String(mockSpawn.mock.calls[0]?.[1]?.at(-1))).toContain("42");
    expect(result.type).toBe("active");
  });
});
