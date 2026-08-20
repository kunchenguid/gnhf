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
      /**
       * Resolves false once the helper is positively known not to be holding
       * the machine awake. Readiness is settled off the startup path so the
       * run is not blocked behind it; the answer is only needed at shutdown.
       */
      confirmed: Promise<boolean>;
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
const HELPER_READY_TIMEOUT_MS = 15_000;
const HELPER_STDIO_FLUSH_TIMEOUT_MS = 1_000;
const HELPER_STDERR_TAIL_LIMIT = 2_000;
const WINDOWS_HELPER_READY_MARKER = "gnhf-sleep-ready";

interface HelperReadiness {
  marker: string;
  timeoutMs: number;
}

interface HelperProcess {
  child: ChildProcess;
  confirmed: Promise<boolean>;
  markStopping: () => void;
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
    "$ErrorActionPreference = 'Stop';",
    // ES_CONTINUOUS (0x80000000) and ES_SYSTEM_REQUIRED (0x00000001), written
    // as [uint32]-typed decimals on purpose: Windows PowerShell parses the hex
    // literal 0x80000000 as a signed Int32, so the P/Invoke uint conversion
    // throws while the helper stays alive, silently leaving the machine free to
    // sleep. Covered by sleep.windows.test.ts.
    "[uint32]$ES_CONTINUOUS = 2147483648;",
    "[uint32]$ES_SYSTEM_REQUIRED = 1;",
    "try {",
    "Add-Type @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class SleepBlock {",
    '  [DllImport("kernel32.dll")]',
    "  public static extern uint SetThreadExecutionState(uint flags);",
    "}",
    "'@;",
    "if ([SleepBlock]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED) -eq 0) { throw 'SetThreadExecutionState returned 0'; }",
    "} catch {",
    "[Console]::Error.WriteLine($_.Exception.Message);",
    "exit 1;",
    "}",
    // Only reachable once the execution state is actually held, so a helper
    // that fails for any reason is reported as unavailable rather than
    // silently counted as active.
    `[Console]::Out.WriteLine('${WINDOWS_HELPER_READY_MARKER}');`,
    "[Console]::Out.Flush();",
    `try { Wait-Process -Id ${parentPid} } catch { } finally { [SleepBlock]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null }`,
  ].join("\n");
}

function trackStdioClose(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once("close", () => resolve());
  });
}

async function waitForStdioFlush(
  closed: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });

  try {
    await Promise.race([closed, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

function collectStderrTail(child: ChildProcess): () => string {
  let tail = "";
  const stderr = child.stderr;
  if (!stderr) return () => tail;

  stderr.setEncoding("utf-8");
  stderr.on("data", (chunk: string) => {
    tail = (tail + chunk).slice(-HELPER_STDERR_TAIL_LIMIT);
  });
  return () => tail.trim();
}

interface HelperReadyOutcome {
  ready: boolean;
  timedOut: boolean;
}

async function waitForHelperReady(
  child: ChildProcess,
  readiness: HelperReadiness,
  stopped: Promise<void>,
): Promise<HelperReadyOutcome> {
  const stdout = child.stdout;
  if (!stdout) return { ready: false, timedOut: false };

  return await new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let buffered = "";
    const settle = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout.off("data", onData);
      child.off("exit", onEnd);
      child.off("error", onEnd);
      resolve({ ready, timedOut });
    };
    const onData = (chunk: string) => {
      buffered = (buffered + chunk).slice(-HELPER_STDERR_TAIL_LIMIT);
      if (buffered.includes(readiness.marker)) settle(true);
    };
    const onEnd = () => {
      settle(false);
    };

    // The deadline only decides what gets reported. A helper that is merely
    // slow to compile still holds the machine awake once it catches up, so it
    // is left running until it exits on its own or cleanup tears it down.
    const timer = setTimeout(() => {
      timedOut = true;
    }, readiness.timeoutMs);
    timer.unref?.();

    stdout.setEncoding("utf-8");
    stdout.on("data", onData);
    child.once("exit", onEnd);
    child.once("error", onEnd);
    void stopped.then(() => settle(false));

    if (child.exitCode != null || child.signalCode != null) settle(false);
  });
}

async function confirmHelperReadiness(options: {
  child: ChildProcess;
  closed: Promise<void>;
  command: string;
  isStopping: () => boolean;
  readiness: HelperReadiness;
  stderrTail: () => string;
  stopped: Promise<void>;
}): Promise<boolean> {
  const { child, closed, command, isStopping, readiness, stderrTail, stopped } =
    options;

  try {
    const { ready, timedOut } = await waitForHelperReady(
      child,
      readiness,
      stopped,
    );
    child.stdout?.resume();

    if (ready) {
      appendDebugLog("sleep:ready", { command });
      return true;
    }

    // A helper torn down by our own cleanup before the deadline never failed;
    // only a helper that gave up on its own, or that stayed silent past the
    // deadline, counts as a failure worth reporting.
    if (isStopping() && !timedOut) return true;

    const exited = child.exitCode != null || child.signalCode != null;
    const exitCode = child.exitCode;
    // The pipes are only guaranteed to have drained once "close" fires, so
    // the helper's stderr is read after the stream is done, not on "exit".
    await waitForStdioFlush(closed, HELPER_STDIO_FLUSH_TIMEOUT_MS);

    const stderr = stderrTail();
    appendDebugLog("sleep:unavailable", {
      command,
      reason: exited ? "early-exit" : "ready-timeout",
      ...(exited ? {} : { timeoutMs: readiness.timeoutMs }),
      ...(exitCode != null ? { exitCode } : {}),
      ...(stderr ? { stderr } : {}),
    });
    return false;
  } catch (error) {
    appendDebugLog("sleep:unavailable", {
      command,
      reason: "confirm-failed",
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function startHelperProcess(
  command: string,
  args: string[],
  spawnFn: typeof spawn,
  env: NodeJS.ProcessEnv,
  readiness?: HelperReadiness,
): Promise<HelperProcess | null> {
  const child = spawnFn(command, args, {
    env,
    stdio: readiness ? ["ignore", "pipe", "pipe"] : "ignore",
  });
  const stderrTail = collectStderrTail(child);
  const closed = trackStdioClose(child);

  const spawned = await waitForSpawn(child);
  if (!spawned) {
    appendDebugLog("sleep:unavailable", { command });
    return null;
  }

  if (readiness) {
    let stopping = false;
    let resolveStopped = () => {};
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    return {
      child,
      confirmed: confirmHelperReadiness({
        child,
        closed,
        command,
        isStopping: () => stopping,
        readiness,
        stderrTail,
        stopped,
      }),
      markStopping: () => {
        stopping = true;
        resolveStopped();
      },
    };
  }

  const stable = await waitForHelperStability(child, HELPER_STARTUP_GRACE_MS);
  if (!stable) {
    appendDebugLog("sleep:unavailable", {
      command,
      reason: "early-exit",
    });
    return null;
  }

  return {
    child,
    confirmed: Promise.resolve(true),
    markStopping: () => {},
  };
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
    const helper = await startHelperProcess(
      "caffeinate",
      ["-i", "-w", String(pid)],
      spawnFn,
      env,
    );
    if (!helper) return { type: "skipped", reason: "unavailable" };

    appendDebugLog("sleep:active", { command: "caffeinate" });
    return {
      type: "active",
      confirmed: helper.confirmed,
      cleanup: async () => {
        helper.markStopping();
        appendDebugLog("sleep:cleanup", { command: "caffeinate" });
        await shutdownChildProcess(helper.child, {
          detached: false,
          timeoutMs: 1_000,
        });
      },
    };
  }

  if (platform === "win32") {
    const helper = await startHelperProcess(
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
      {
        marker: WINDOWS_HELPER_READY_MARKER,
        timeoutMs: HELPER_READY_TIMEOUT_MS,
      },
    );
    if (!helper) return { type: "skipped", reason: "unavailable" };

    appendDebugLog("sleep:active", { command: "powershell.exe" });
    return {
      type: "active",
      confirmed: helper.confirmed,
      cleanup: async () => {
        helper.markStopping();
        appendDebugLog("sleep:cleanup", { command: "powershell.exe" });
        await shutdownChildProcess(helper.child, {
          detached: false,
          timeoutMs: 1_000,
        });
      },
    };
  }

  return { type: "skipped", reason: "unsupported" };
}
