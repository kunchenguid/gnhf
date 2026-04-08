import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  shutdownChildProcess,
  signalChildProcess,
} from "./agents/managed-process.js";
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
  killProcess?: typeof process.kill;
  pid?: number;
  platform?: NodeJS.Platform;
  processExecArgv?: string[];
  processArgv1?: string;
  processExecPath?: string;
  processOff?: typeof process.off;
  processOn?: typeof process.on;
  reexecEnv?: NodeJS.ProcessEnv;
  spawn?: typeof spawn;
}

const SYSTEMD_INHIBIT_READY_TIMEOUT_MS = 5_000;
const SYSTEMD_INHIBIT_READY_POLL_MS = 25;
const GNHF_SLEEP_REEXEC_READY_PATH = "GNHF_SLEEP_REEXEC_READY_PATH";
const GNHF_SLEEP_REEXEC_READY_DIR_PREFIX = "gnhf-sleep-";
const GNHF_SLEEP_REEXEC_READY_FILENAME = "reexec-ready";
const HELPER_STARTUP_GRACE_MS = 100;

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

async function waitForHelperStability(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  return await new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(value);
    };

    child.once("exit", () => {
      settle(false);
    });
    child.once("error", () => {
      settle(false);
    });

    if (child.exitCode != null || child.signalCode != null) {
      settle(false);
      return;
    }

    timer = setTimeout(() => {
      settle(true);
    }, timeoutMs);
    timer.unref?.();
  });
}

function isTrustedLinuxReexecReadyPath(readyPath: string): boolean {
  const resolvedReadyPath = resolve(readyPath);
  const readyDir = dirname(resolvedReadyPath);
  return (
    basename(resolvedReadyPath) === GNHF_SLEEP_REEXEC_READY_FILENAME &&
    dirname(readyDir) === resolve(tmpdir()) &&
    basename(readyDir).startsWith(GNHF_SLEEP_REEXEC_READY_DIR_PREFIX)
  );
}

function signalLinuxReexecReady(env: NodeJS.ProcessEnv): void {
  const readyPath = env[GNHF_SLEEP_REEXEC_READY_PATH];
  if (!readyPath) return;
  if (!isTrustedLinuxReexecReadyPath(readyPath)) {
    appendDebugLog("sleep:ready-signal-failed", {
      command: "systemd-inhibit",
      error: "untrusted ready path",
    });
    return;
  }

  try {
    writeFileSync(readyPath, "ready\n", { encoding: "utf-8", flag: "wx" });
  } catch (error) {
    appendDebugLog("sleep:ready-signal-failed", {
      command: "systemd-inhibit",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function waitForLinuxReexecReady(
  readyPath: string,
  exitStatePromise: Promise<{
    exitCode: number;
    signal: NodeJS.Signals | null;
  }>,
  timeoutMs: number,
): Promise<
  | { type: "ready" }
  | { type: "exit"; exitCode: number; signal: NodeJS.Signals | null }
  | { type: "timeout" }
> {
  if (existsSync(readyPath)) {
    return { type: "ready" };
  }

  return await new Promise((resolve) => {
    let settled = false;
    const settle = (
      result:
        | { type: "ready" }
        | { type: "exit"; exitCode: number; signal: NodeJS.Signals | null }
        | { type: "timeout" },
    ) => {
      if (settled) return;
      settled = true;
      clearInterval(poller);
      clearTimeout(timeout);
      resolve(result);
    };

    const poller = setInterval(() => {
      if (existsSync(readyPath)) {
        settle({ type: "ready" });
      }
    }, SYSTEMD_INHIBIT_READY_POLL_MS);
    poller.unref?.();

    const timeout = setTimeout(() => {
      settle({ type: "timeout" });
    }, timeoutMs);
    timeout.unref?.();

    void exitStatePromise.then(({ exitCode, signal }) => {
      settle({ type: "exit", exitCode, signal });
    });
  });
}

function forwardTerminationSignalsToChild(
  child: ChildProcess,
  detached: boolean,
  killProcess: typeof process.kill,
  processOn: typeof process.on,
  processOff: typeof process.off,
): () => void {
  const listeners: Array<[NodeJS.Signals, () => void]> = [];

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const listener = () => {
      try {
        signalChildProcess(child, {
          detached,
          killProcess,
          signal,
        });
      } catch {
        // Best-effort only.
      }
    };
    processOn(signal, listener);
    listeners.push([signal, listener]);
  }

  return () => {
    for (const [signal, listener] of listeners) {
      processOff(signal, listener);
    }
  };
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
  ].join("\n");
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

  const stable = await waitForHelperStability(child, HELPER_STARTUP_GRACE_MS);
  if (!stable) {
    appendDebugLog("sleep:unavailable", {
      command,
      reason: "early-exit",
    });
    return null;
  }

  return child;
}

export async function startSleepPrevention(
  argv: string[],
  deps: SleepPreventionDeps = {},
): Promise<SleepPreventionResult> {
  const env = deps.env ?? process.env;
  const killProcess = deps.killProcess ?? process.kill.bind(process);
  const pid = deps.pid ?? process.pid;
  const platform = deps.platform ?? process.platform;
  const processExecArgv = deps.processExecArgv ?? process.execArgv;
  const processArgv1 = deps.processArgv1 ?? process.argv[1];
  const processExecPath = deps.processExecPath ?? process.execPath;
  const processOn = deps.processOn ?? process.on.bind(process);
  const processOff = deps.processOff ?? process.off.bind(process);
  const reexecEnv = deps.reexecEnv ?? {};
  const spawnFn = deps.spawn ?? spawn;

  if (platform === "linux") {
    if (env.GNHF_SLEEP_INHIBITED === "1") {
      signalLinuxReexecReady(env);
      return { type: "skipped", reason: "already-inhibited" };
    }

    const readyDir = mkdtempSync(
      join(tmpdir(), GNHF_SLEEP_REEXEC_READY_DIR_PREFIX),
    );
    const readyPath = join(readyDir, GNHF_SLEEP_REEXEC_READY_FILENAME);
    const child = spawnFn(
      "systemd-inhibit",
      [
        "--what=idle:sleep",
        "--mode=block",
        "--who=gnhf",
        "--why=Prevent sleep while gnhf is running",
        processExecPath,
        ...processExecArgv,
        processArgv1,
        ...argv,
      ],
      {
        detached: true,
        env: {
          ...env,
          ...reexecEnv,
          GNHF_SLEEP_INHIBITED: "1",
          [GNHF_SLEEP_REEXEC_READY_PATH]: readyPath,
        },
        stdio: "inherit",
      },
    );
    const exitStatePromise = new Promise<{
      exitCode: number;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once("exit", (code, signal) => {
        resolve({
          exitCode: signal ? getSignalExitCode(signal) : (code ?? 1),
          signal,
        });
      });
    });

    // Register signal forwarding immediately so SIGINT/SIGTERM received
    // between spawn and the readiness check are forwarded to the child.
    const stopForwardingSignals = forwardTerminationSignalsToChild(
      child,
      true,
      killProcess,
      processOn,
      processOff,
    );

    const spawned = await waitForSpawn(child);
    if (!spawned) {
      stopForwardingSignals();
      rmSync(readyDir, { recursive: true, force: true });
      appendDebugLog("sleep:unavailable", { command: "systemd-inhibit" });
      return { type: "skipped", reason: "unavailable" };
    }

    try {
      const readyState = await waitForLinuxReexecReady(
        readyPath,
        exitStatePromise,
        SYSTEMD_INHIBIT_READY_TIMEOUT_MS,
      );
      try {
        if (readyState.type === "ready") {
          appendDebugLog("sleep:reexec", { command: "systemd-inhibit" });
          const { exitCode } = await exitStatePromise;
          return {
            type: "reexeced",
            exitCode,
          };
        }

        if (readyState.type === "exit") {
          if (
            readyState.signal === "SIGINT" ||
            readyState.signal === "SIGTERM"
          ) {
            appendDebugLog("sleep:reexec", {
              command: "systemd-inhibit",
              signal: readyState.signal,
            });
            return { type: "reexeced", exitCode: readyState.exitCode };
          }

          if (readyState.exitCode !== 0) {
            if (existsSync(readyPath)) {
              appendDebugLog("sleep:reexec", {
                command: "systemd-inhibit",
                exitCode: readyState.exitCode,
                readySignal: "late",
              });
              return { type: "reexeced", exitCode: readyState.exitCode };
            }

            appendDebugLog("sleep:unavailable", {
              command: "systemd-inhibit",
              exitCode: readyState.exitCode,
            });
            return { type: "skipped", reason: "unavailable" };
          }

          appendDebugLog("sleep:reexec", {
            command: "systemd-inhibit",
            readySignal: false,
          });
          return { type: "reexeced", exitCode: readyState.exitCode };
        }

        appendDebugLog("sleep:unavailable", {
          command: "systemd-inhibit",
          reason: "timeout",
          timeoutMs: SYSTEMD_INHIBIT_READY_TIMEOUT_MS,
        });
        await shutdownChildProcess(child, {
          detached: true,
          killProcess,
          timeoutMs: 1_000,
        });
        return { type: "skipped", reason: "unavailable" };
      } finally {
        stopForwardingSignals();
      }
    } finally {
      rmSync(readyDir, { recursive: true, force: true });
    }
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
