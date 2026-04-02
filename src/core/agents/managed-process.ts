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
  const timeoutMs = options.timeoutMs ?? 3_000;
  const waitForClose = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });

  try {
    signalChildProcess(child, { ...options, signal: "SIGTERM" });
  } catch {
    // Best-effort cleanup only.
  }

  const forceKill = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        signalChildProcess(child, { ...options, signal: "SIGKILL" });
      } catch {
        // Best-effort cleanup only.
      }
      resolve();
    }, timeoutMs);
    timer.unref?.();
  });

  await Promise.race([waitForClose, forceKill]);
}
