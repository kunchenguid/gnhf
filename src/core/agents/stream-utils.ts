import { execFileSync, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import type { WriteStream } from "node:fs";

/**
 * npm installs some agent CLIs as `.cmd`/`.bat` shims on Windows, which
 * `spawn` can only launch through a shell. Bare names are resolved with
 * `where` so a configured override that points at a shim still works.
 */
export function shouldUseWindowsShell(
  bin: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform !== "win32") {
    return false;
  }

  if (/\.(cmd|bat)$/i.test(bin)) {
    return true;
  }

  if (/[\\/]/.test(bin)) {
    return false;
  }

  try {
    const resolved = execFileSync("where", [bin], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const firstMatch = resolved
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return firstMatch ? /\.(cmd|bat)$/i.test(firstMatch) : false;
  } catch {
    return false;
  }
}

/**
 * Whether an agent CLI should be spawned as its own process-group leader.
 * Group leadership is what lets `terminateChildProcess` reach the tools the
 * agent spawned; Windows has no process groups and uses `taskkill /T` instead.
 */
export function spawnsDetached(platform: NodeJS.Platform): boolean {
  return platform !== "win32";
}

/**
 * Terminate a spawned agent CLI and, where possible, everything it started.
 *
 * `detached` must match the `detached` option the child was spawned with:
 * signalling the negated pid only reaches the agent's own descendants when the
 * child leads its own process group, and would otherwise signal gnhf's group.
 */
export function terminateChildProcess(
  child: ChildProcess,
  platform: NodeJS.Platform,
  { detached }: { detached: boolean },
): void {
  if (platform === "win32" && child.pid) {
    try {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
        stdio: "ignore",
      });
    } catch {
      // Best-effort: the process may have already exited.
    }
    return;
  }

  if (detached && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // Fall back to the direct child if it was not started as a process group.
    }
  }

  child.kill("SIGTERM");
}

/**
 * Wire stderr collection, spawn-error handling, and the common close-handler
 * prefix (logStream.end + non-zero exit code rejection) for a child process.
 * Calls `onSuccess` only when the process exits with code 0.
 */
export function setupChildProcessHandlers(
  child: ChildProcess,
  agentName: string,
  logStream: WriteStream | null,
  reject: (err: Error) => void,
  onSuccess: () => void,
): void {
  let stderr = "";

  child.stderr!.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  child.on("error", (err) => {
    reject(new Error(`Failed to spawn ${agentName}: ${err.message}`));
  });

  child.on("close", (code) => {
    logStream?.end();
    if (code !== 0) {
      reject(new Error(`${agentName} exited with code ${code}: ${stderr}`));
      return;
    }
    onSuccess();
  });
}

/**
 * Parse a JSONL stream, calling the callback for each parsed event.
 * Handles buffering of incomplete lines and skips unparseable lines.
 */
export function parseJSONLStream<T>(
  stream: Readable,
  logStream: WriteStream | null,
  callback: (event: T) => void,
): void {
  let buffer = "";
  stream.on("data", (data: Buffer) => {
    logStream?.write(data);
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        callback(JSON.parse(line) as T);
      } catch {
        // Skip unparseable lines
      }
    }
  });
}

/**
 * Wire an AbortSignal to kill a child process.
 * Returns true if the signal was already aborted (caller should return early).
 */
export function setupAbortHandler(
  signal: AbortSignal | undefined,
  child: ChildProcess,
  reject: (err: Error) => void,
  abortChild: () => void = () => {
    child.kill("SIGTERM");
  },
): boolean {
  if (!signal) return false;

  const onAbort = () => {
    abortChild();
    reject(new Error("Agent was aborted"));
  };
  if (signal.aborted) {
    onAbort();
    return true;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  child.on("close", () => signal.removeEventListener("abort", onAbort));
  return false;
}
