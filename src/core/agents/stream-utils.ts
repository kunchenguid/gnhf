import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import type { WriteStream } from "node:fs";

/**
 * Wire stderr collection, spawn-error handling, and the common close-handler
 * prefix (logStream.end + non-zero exit code rejection) for a child process.
 * Calls `onSuccess` only when the process exits with code 0.
 *
 * Pass `classifyExitError` to upgrade specific stderr patterns to a custom
 * error (such as `PermanentAgentError`) on non-zero exits. Return `null` from
 * the classifier to keep the default `${agent} exited with code ${code}` error.
 */
export function setupChildProcessHandlers(
  child: ChildProcess,
  agentName: string,
  logStream: WriteStream | null,
  reject: (err: Error) => void,
  onSuccess: () => void,
  classifyExitError?: (stderr: string, defaultMessage: string) => Error | null,
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
      const defaultMessage = `${agentName} exited with code ${code}: ${stderr}`;
      const classified = classifyExitError?.(stderr, defaultMessage) ?? null;
      reject(classified ?? new Error(defaultMessage));
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
