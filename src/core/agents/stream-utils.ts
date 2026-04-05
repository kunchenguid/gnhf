import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import type { WriteStream } from "node:fs";

const MAX_STDERR_BUFFER = 64 * 1024;

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

  const stderrHandler = (data: Buffer) => {
    stderr += data.toString();
    if (stderr.length > MAX_STDERR_BUFFER) {
      stderr = stderr.slice(-MAX_STDERR_BUFFER);
    }
  };
  child.stderr!.on("data", stderrHandler);

  child.on("error", (err) => {
    child.stderr?.off("data", stderrHandler);
    reject(new Error(`Failed to spawn ${agentName}: ${err.message}`));
  });

  child.on("close", (code) => {
    child.stderr?.off("data", stderrHandler);
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
 * Returns a cleanup function to remove the data listener.
 */
export function parseJSONLStream<T>(
  stream: Readable,
  logStream: WriteStream | null,
  callback: (event: T) => void,
): () => void {
  let buffer = "";
  const handler = (data: Buffer) => {
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
  };
  stream.on("data", handler);
  return () => stream.off("data", handler);
}

/**
 * Async JSONL stream parser that properly handles backpressure.
 * Uses `for await...of` on the stream to ensure the consumer
 * controls the flow and prevents pipe-buffer deadlock.
 *
 * Drains stderr concurrently to prevent the child from blocking
 * on stderr writes.
 */
export async function consumeJSONLStream<T>(
  child: ChildProcess,
  logStream: WriteStream | null,
  onEvent: (event: T) => void,
): Promise<void> {
  const stdout = child.stdout;
  const stderr = child.stderr;

  if (!stdout) {
    throw new Error("Child process has no stdout");
  }

  // Drain stderr by putting it into flowing mode without a listener.
  // This prevents backpressure on stderr from blocking the child process.
  if (stderr) {
    stderr.resume();
  }

  // Propagate child process errors (e.g., spawn failures) through the stream.
  const errorPromise = new Promise<never>((_, reject) => {
    child.once("error", (err) => {
      stdout.destroy();
      reject(new Error(`Child process error: ${err.message}`));
    });
  });

  let buffer = "";

  const consume = async () => {
    for await (const chunk of stdout) {
      const text = chunk.toString();
      logStream?.write(text);
      buffer += text;

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          onEvent(JSON.parse(line) as T);
        } catch {
          // Skip unparseable lines
        }
      }
    }

    // Process any remaining buffer after stream ends.
    if (buffer.trim()) {
      try {
        onEvent(JSON.parse(buffer) as T);
      } catch {
        // Skip unparseable trailing data
      }
    }
  };

  await Promise.race([consume(), errorPromise]);
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

  let settled = false;
  const onAbort = () => {
    if (settled) return;
    settled = true;
    abortChild();
    reject(new Error("Agent was aborted"));
  };
  if (signal.aborted) {
    onAbort();
    return true;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  child.on("close", () => {
    settled = true;
    signal.removeEventListener("abort", onAbort);
  });
  return false;
}
