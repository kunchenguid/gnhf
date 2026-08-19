import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";

import { startSleepPrevention } from "./sleep.js";

// These tests execute the real PowerShell helper gnhf spawns on Windows, so
// they only make sense on win32. A helper that gnhf reports as active but that
// never applies SetThreadExecutionState is a silent failure: gnhf claims sleep
// prevention is on while the machine still sleeps mid-run.
const describeWindows = describe.skipIf(process.platform !== "win32");

const SETTLE_MS = 5_000;

interface CapturedSpawn {
  command: string;
  args: string[];
}

function createStubChild(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    pid: 4321,
    kill: () => true as const,
    signalCode: null,
  });
  return child as unknown as ChildProcess;
}

/** Captures the exact command line gnhf hands to the OS for a given parent. */
async function captureHelperSpawn(parentPid: number): Promise<CapturedSpawn> {
  let captured: CapturedSpawn | null = null;
  const stubSpawn = ((command: string, args: string[]) => {
    captured = { command, args };
    const child = createStubChild();
    queueMicrotask(() => child.emit("spawn"));
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

  it(
    "applies SetThreadExecutionState without a flag conversion error",
    { timeout: 60_000 },
    async () => {
      // A live parent keeps the helper in its Wait-Process stage, which is the
      // same shape as a real gnhf run.
      const parent = spawn(
        process.execPath,
        ["-e", "setTimeout(() => {}, 60000)"],
        {
          stdio: "ignore",
        },
      );
      started.push(parent);
      const parentPid = await waitForSpawn(parent);

      const captured = await captureHelperSpawn(parentPid);
      const helper = spawn(captured.command, captured.args, {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      started.push(helper);
      await waitForSpawn(helper);

      let stderr = "";
      let helperExited = false;
      helper.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      helper.once("exit", () => {
        helperExited = true;
      });

      // Windows PowerShell parses 0x80000000 as a signed Int32, so with the old
      // flag literals the uint P/Invoke argument conversion throws here, within
      // a second of Add-Type finishing. The helper survives that error and
      // keeps waiting, which is exactly why the failure is invisible to gnhf.
      const deadline = Date.now() + SETTLE_MS;
      while (Date.now() < deadline && stderr === "" && !helperExited) {
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(stderr).toBe("");
      // Still holding the execution state on behalf of the live parent.
      expect(helperExited).toBe(false);
    },
  );
});
