import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { createWriteStream } from "node:fs";
import { appendDebugLog, serializeError } from "../debug-log.js";

/** Sink for raw agent stdout. */
export interface AgentLogSink {
  write(chunk: string | Buffer): void;
}

/**
 * Per-run log file for adapters that spawn a CLI once per turn.
 *
 * An agent run can span more than one spawn (an empty-response continuation
 * reuses the same log file), and a turn can be rejected - by an abort, say -
 * while its child is still streaming stdout. Ending the file on either event
 * alone would truncate a later turn or write after end, so the file is closed
 * only once the run has finished *and* every child it spawned has exited.
 */
export class AgentLogFile implements AgentLogSink {
  private readonly stream: ReturnType<typeof createWriteStream> | null;
  private readonly closePromise: Promise<void>;
  private openChildren = 0;
  private runFinished = false;
  private ended = false;

  constructor(logPath?: string) {
    const stream = logPath ? createWriteStream(logPath) : null;
    this.stream = stream;
    this.closePromise = stream
      ? new Promise((resolve) => stream.once("close", () => resolve()))
      : Promise.resolve();
    // Log writes are best effort; a failed write must not take down the run.
    stream?.on("error", (error) => {
      appendDebugLog("agent:log:write-failed", {
        error: serializeError(error),
      });
    });
  }

  write(chunk: string | Buffer): void {
    if (this.ended) return;
    this.stream?.write(chunk);
  }

  /** Keep the file open until `child` has exited. */
  track(child: ChildProcess): void {
    this.openChildren += 1;
    let settled = false;
    const onChildGone = () => {
      if (settled) return;
      settled = true;
      this.openChildren -= 1;
      this.endIfIdle();
    };
    child.on("close", onChildGone);
    child.on("error", onChildGone);
  }

  /** The run is done; close as soon as no tracked child is still running. */
  finish(): Promise<void> {
    this.runFinished = true;
    this.endIfIdle();
    return this.closePromise;
  }

  private endIfIdle(): void {
    if (this.ended || !this.runFinished || this.openChildren > 0) return;
    this.ended = true;
    this.stream?.end();
  }
}

/**
 * Wire stderr collection, spawn-error handling, and non-zero exit rejection
 * for a child process. Calls `onSuccess` only when the process exits with
 * code 0.
 *
 * The log file is deliberately not owned here - see `AgentLogFile`.
 */
export function setupChildProcessHandlers(
  child: ChildProcess,
  agentName: string,
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
  logStream: AgentLogSink | null,
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
