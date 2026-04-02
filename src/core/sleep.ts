import { spawn, type ChildProcess } from "node:child_process";
import { shutdownChildProcess } from "./agents/managed-process.js";
import { appendDebugLog } from "./debug-log.js";

export type SleepPreventionResult =
  | {
      type: "active";
      cleanup: () => Promise<void>;
    }
  | {
      type: "reexeced";
      exitCode: number;
    }
  | {
      type: "skipped";
      reason: "already-inhibited" | "unavailable" | "unsupported";
    };

interface SleepPreventionDeps {
  env?: NodeJS.ProcessEnv;
  pid?: number;
  platform?: NodeJS.Platform;
  processArgv1?: string;
  processExecPath?: string;
  spawn?: typeof spawn;
}

function getSignalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

async function waitForSpawn(child: ChildProcess): Promise<boolean> {
  return await new Promise((resolve) => {
    child.once("spawn", () => resolve(true));
    child.once("error", () => resolve(false));
  });
}

function buildPowerShellCommand(parentPid: number): string {
  return [
    "Add-Type @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class SleepBlock {",
    '  [DllImport("kernel32.dll")]',
    "  public static extern uint SetThreadExecutionState(uint flags);",
    "}",
    "'@;",
    "$ES_CONTINUOUS = 0x80000000;",
    "$ES_SYSTEM_REQUIRED = 0x00000001;",
    "[SleepBlock]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED) | Out-Null;",
    `try { Wait-Process -Id ${parentPid} } catch { } finally { [SleepBlock]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null }`,
  ].join(" ");
}

async function startHelperProcess(
  command: string,
  args: string[],
  spawnFn: typeof spawn,
  env: NodeJS.ProcessEnv,
): Promise<ChildProcess | null> {
  const child = spawnFn(command, args, {
    env,
    stdio: "ignore",
  });

  const spawned = await waitForSpawn(child);
  if (!spawned) {
    appendDebugLog("sleep:unavailable", { command });
    return null;
  }

  return child;
}

export async function startSleepPrevention(
  argv: string[],
  deps: SleepPreventionDeps = {},
): Promise<SleepPreventionResult> {
  const env = deps.env ?? process.env;
  const pid = deps.pid ?? process.pid;
  const platform = deps.platform ?? process.platform;
  const processArgv1 = deps.processArgv1 ?? process.argv[1];
  const processExecPath = deps.processExecPath ?? process.execPath;
  const spawnFn = deps.spawn ?? spawn;

  if (platform === "linux") {
    if (env.GNHF_SLEEP_INHIBITED === "1") {
      return { type: "skipped", reason: "already-inhibited" };
    }

    const child = spawnFn(
      "systemd-inhibit",
      [
        "--what=idle:sleep",
        "--mode=block",
        "--who=gnhf",
        "--why=Prevent sleep while gnhf is running",
        processExecPath,
        processArgv1,
        ...argv,
      ],
      {
        env: { ...env, GNHF_SLEEP_INHIBITED: "1" },
        stdio: "inherit",
      },
    );
    const exitCodePromise = new Promise<number>((resolve) => {
      child.once("exit", (code, signal) => {
        resolve(signal ? getSignalExitCode(signal) : (code ?? 1));
      });
    });

    const spawned = await waitForSpawn(child);
    if (!spawned) {
      appendDebugLog("sleep:unavailable", { command: "systemd-inhibit" });
      return { type: "skipped", reason: "unavailable" };
    }

    appendDebugLog("sleep:reexec", { command: "systemd-inhibit" });
    const exitCode = await exitCodePromise;
    return { type: "reexeced", exitCode };
  }

  if (platform === "darwin") {
    const child = await startHelperProcess(
      "caffeinate",
      ["-i", "-w", String(pid)],
      spawnFn,
      env,
    );
    if (!child) return { type: "skipped", reason: "unavailable" };

    appendDebugLog("sleep:active", { command: "caffeinate" });
    return {
      type: "active",
      cleanup: async () => {
        appendDebugLog("sleep:cleanup", { command: "caffeinate" });
        await shutdownChildProcess(child, {
          detached: false,
          timeoutMs: 1_000,
        });
      },
    };
  }

  if (platform === "win32") {
    const child = await startHelperProcess(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        buildPowerShellCommand(pid),
      ],
      spawnFn,
      env,
    );
    if (!child) return { type: "skipped", reason: "unavailable" };

    appendDebugLog("sleep:active", { command: "powershell.exe" });
    return {
      type: "active",
      cleanup: async () => {
        appendDebugLog("sleep:cleanup", { command: "powershell.exe" });
        await shutdownChildProcess(child, {
          detached: false,
          timeoutMs: 1_000,
        });
      },
    };
  }

  return { type: "skipped", reason: "unsupported" };
}
