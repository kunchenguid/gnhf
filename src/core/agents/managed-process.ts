import type { ChildProcess } from "node:child_process";

interface SignalChildProcessOptions {
  detached: boolean;
  killProcess?: typeof process.kill;
  signal: NodeJS.Signals;
}

interface ShutdownChildProcessOptions {
  detached: boolean;
  killProcess?: typeof process.kill;
  timeoutMs?: number;
}

const POST_SIGKILL_GRACE_MS = 100;

export function signalChildProcess(
  child: ChildProcess,
  options: SignalChildProcessOptions,
): void {
  const killProcess = options.killProcess ?? process.kill.bind(process);

  if (options.detached && child.pid) {
    try {
      killProcess(-child.pid, options.signal);
      return;
    } catch {
      // Fall back to the direct child below.
    }
  }

  child.kill(options.signal);
}

export async function shutdownChildProcess(
  child: ChildProcess,
  options: ShutdownChildProcessOptions,
): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) {
    return;
  }

  const timeoutMs = options.timeoutMs ?? 3_000;
  await new Promise<void>((resolve) => {
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let hardDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const settle = () => {
      if (settled) return;
      settled = true;
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = null;
      }
      if (hardDeadlineTimer) {
        clearTimeout(hardDeadlineTimer);
        hardDeadlineTimer = null;
      }
      child.off("close", handleClose);
      resolve();
    };

    const handleClose = () => {
      settle();
    };

    child.on("close", handleClose);

    try {
      signalChildProcess(child, { ...options, signal: "SIGTERM" });
    } catch {
      // Best-effort cleanup only.
    }

    forceKillTimer = setTimeout(() => {
      try {
        signalChildProcess(child, { ...options, signal: "SIGKILL" });
      } catch {
        // Best-effort cleanup only.
      }

      hardDeadlineTimer = setTimeout(() => {
        settle();
      }, POST_SIGKILL_GRACE_MS);
      hardDeadlineTimer.unref?.();
    }, timeoutMs);
    forceKillTimer.unref?.();
  });
}
