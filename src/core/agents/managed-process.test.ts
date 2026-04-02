import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { shutdownChildProcess, signalChildProcess } from "./managed-process.js";

function createChildProcess(pid = 1234): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid,
    kill: vi.fn(() => true),
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
});
