import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { startSleepPrevention } from "./sleep.js";

// These tests execute the real PowerShell helper gnhf spawns on Windows, so
// they only make sense on win32. A helper that gnhf reports as active but that
// never applies SetThreadExecutionState is a silent failure: gnhf claims sleep
// prevention is on while the machine still sleeps mid-run.
const describeWindows = describe.skipIf(process.platform !== "win32");

const READY_MARKER = "gnhf-sleep-ready";
const HELPER_TIMEOUT_MS = 45_000;

interface CapturedSpawn {
  command: string;
  args: string[];
}

function createStubChild(): ChildProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    pid: 4321,
    kill: () => true as const,
    signalCode: null,
    stdout,
    stderr,
  });
  return child as unknown as ChildProcess;
}

/** Captures the exact command line gnhf hands to the OS for a given parent. */
async function captureHelperSpawn(parentPid: number): Promise<CapturedSpawn> {
  let captured: CapturedSpawn | null = null;
  const stubSpawn = ((command: string, args: string[]) => {
    captured = { command, args };
    const child = createStubChild();
    queueMicrotask(() => {
      child.emit("spawn");
      child.stdout?.push(`${READY_MARKER}\n`);
    });
    return child;
  }) as unknown as typeof spawn;

  const result = await startSleepPrevention(["ship it"], {
    pid: parentPid,
    platform: "win32",
    spawn: stubSpawn,
  });

  expect(result.type).toBe("active");
  if (!captured) throw new Error("no helper process was spawned");
  return captured;
}

function waitForSpawn(child: ChildProcess): Promise<number> {
  return new Promise((resolvePid, rejectSpawn) => {
    child.once("spawn", () => resolvePid(child.pid ?? 0));
    child.once("error", rejectSpawn);
  });
}

/**
 * Resolves as soon as the helper reports ready or exits, so the assertions
 * never depend on a fixed settle window: a helper that fails the flag
 * conversion exits and is observed, however slowly PowerShell got there.
 */
function waitForReadyOrExit(
  child: ChildProcess,
  state: { stdout: string },
): Promise<"ready" | "exit"> {
  return new Promise((resolveOutcome, rejectOutcome) => {
    let settled = false;
    const settle = (outcome: "ready" | "exit") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveOutcome(outcome);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectOutcome(
        new Error("helper neither reported ready nor exited in time"),
      );
    }, HELPER_TIMEOUT_MS);

    child.stdout?.on("data", () => {
      if (state.stdout.includes(READY_MARKER)) settle("ready");
    });
    child.once("exit", () => settle("exit"));
    child.once("error", rejectOutcome);

    if (state.stdout.includes(READY_MARKER)) settle("ready");
    else if (child.exitCode != null || child.signalCode != null) settle("exit");
  });
}

/**
 * Registered before the helper can emit anything, so awaiting it is a real
 * flush guarantee: "close" fires only after every stdio pipe has drained,
 * whereas "exit" can arrive while stderr is still buffered.
 */
function trackClose(child: ChildProcess): Promise<number | null> {
  return new Promise((resolveCode) => {
    child.once("close", (code) => resolveCode(code));
  });
}

describeWindows("Windows sleep prevention helper", () => {
  const started: ChildProcess[] = [];

  afterEach(() => {
    for (const child of started.splice(0)) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Best-effort cleanup.
      }
    }
  });

  function spawnParent(): Promise<ChildProcess> {
    const parent = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60000)"],
      {
        stdio: "ignore",
      },
    );
    started.push(parent);
    return waitForSpawn(parent).then(() => parent);
  }

  it(
    "applies SetThreadExecutionState and reports ready without an error",
    { timeout: 90_000 },
    async () => {
      // A live parent keeps the helper in its Wait-Process stage, which is the
      // same shape as a real gnhf run.
      const parent = await spawnParent();

      const captured = await captureHelperSpawn(parent.pid ?? 0);
      const helper = spawn(captured.command, captured.args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      started.push(helper);
      const closed = trackClose(helper);
      await waitForSpawn(helper);

      const state = { stdout: "", stderr: "" };
      helper.stdout?.on("data", (chunk) => {
        state.stdout += String(chunk);
      });
      helper.stderr?.on("data", (chunk) => {
        state.stderr += String(chunk);
      });

      // Windows PowerShell parses 0x80000000 as a signed Int32, so with the
      // old flag literals the uint P/Invoke argument conversion fails and the
      // helper reports the error instead of reaching its ready marker.
      const outcome = await waitForReadyOrExit(helper, state);
      // On the failure path, close flushes the helper's stderr so the
      // assertion below reports the actual PowerShell error.
      if (outcome === "exit") await closed;
      expect(state.stderr).toBe("");
      expect(outcome).toBe("ready");

      // Still holding the execution state on behalf of the live parent.
      expect(helper.exitCode).toBeNull();

      parent.kill("SIGKILL");
      const exitCode = await closed;
      expect(state.stderr).toBe("");
      expect(exitCode).toBe(0);
    },
  );

  it(
    "confirms the real helper is holding the execution state",
    { timeout: 90_000 },
    async () => {
      const parent = await spawnParent();

      const result = await startSleepPrevention(["ship it"], {
        pid: parent.pid,
      });

      expect(result.type).toBe("active");
      if (result.type !== "active") return;

      try {
        // Confirmation is resolved off the startup path, so this awaits the
        // real PowerShell handshake rather than a value gnhf assumed.
        await expect(result.confirmed).resolves.toBe(true);
      } finally {
        await result.cleanup();
      }
    },
  );
});
