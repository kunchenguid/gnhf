import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { shutdownChildProcess, signalChildProcess } from "./managed-process.js";

function createChildProcess(pid = 1234): ChildProcess {
  return Object.assign(new EventEmitter(), {
    exitCode: null,
    pid,
    kill: vi.fn((signal: number | NodeJS.Signals | undefined) => {
      void signal;
      return true as const;
    }),
    signalCode: null,
  }) as unknown as ChildProcess;
}

describe("signalChildProcess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("signals the process group for detached children", () => {
    const child = createChildProcess();
    const killProcess = vi.fn();

    signalChildProcess(child, {
      detached: true,
      killProcess,
      signal: "SIGTERM",
    });

    expect(killProcess).toHaveBeenCalledWith(-1234, "SIGTERM");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("falls back to killing the direct child when process-group signaling fails", () => {
    const child = createChildProcess();
    const killProcess = vi.fn(() => {
      throw new Error("group kill failed");
    });

    signalChildProcess(child, {
      detached: true,
      killProcess,
      signal: "SIGTERM",
    });

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});

describe("shutdownChildProcess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it("force kills the child when graceful shutdown times out", async () => {
    const child = createChildProcess();
    vi.mocked(child.kill).mockImplementation(
      (signal?: number | NodeJS.Signals) => {
        if (signal === "SIGKILL") {
          queueMicrotask(() => {
            child.emit("close", 0, null);
          });
        }
        return true as const;
      },
    );

    const closePromise = shutdownChildProcess(child, {
      detached: false,
      timeoutMs: 3_000,
    });

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    await vi.advanceTimersByTimeAsync(3_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    await closePromise;
    vi.useRealTimers();
  });

  it("waits for close after sending SIGKILL", async () => {
    const child = createChildProcess();
    let resolved = false;

    const closePromise = shutdownChildProcess(child, {
      detached: false,
      timeoutMs: 3_000,
    }).then(() => {
      resolved = true;
    });

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    await vi.advanceTimersByTimeAsync(3_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await Promise.resolve();
    expect(resolved).toBe(false);

    child.emit("close", 0, null);
    await closePromise;
    expect(resolved).toBe(true);

    vi.useRealTimers();
  });

  it("resolves after a hard deadline if the child never closes", async () => {
    const child = createChildProcess();
    let resolved = false;

    const closePromise = shutdownChildProcess(child, {
      detached: false,
      timeoutMs: 3_000,
    }).then(() => {
      resolved = true;
    });

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    await vi.advanceTimersByTimeAsync(3_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    await closePromise;
    expect(resolved).toBe(true);
  });

  it("clears the force-kill timer when the child closes first", async () => {
    const child = createChildProcess();

    const closePromise = shutdownChildProcess(child, {
      detached: false,
      timeoutMs: 3_000,
    });

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("close", 0, null);
    await closePromise;

    await vi.advanceTimersByTimeAsync(3_000);
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");

    vi.useRealTimers();
  });

  it("resolves immediately when the child has already exited", async () => {
    const child = Object.assign(createChildProcess(), {
      exitCode: 0,
    });

    await shutdownChildProcess(child, {
      detached: false,
      timeoutMs: 3_000,
    });

    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");

    vi.useRealTimers();
  });
});
