import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import type { WriteStream } from "node:fs";

/** Upper bound on the stdout tail kept for non-zero-exit error reporting. */
const MAX_EXIT_OUTPUT_CHARS = 4_000;
/**
 * Tighter bound on unstructured stdout quoted back in the failure detail: that
 * text lands in notes.md and is replayed in every later iteration prompt.
 */
const MAX_RAW_TAIL_CHARS = 400;
const RAW_TAIL_ELISION = "[...truncated, full output in the iteration log] ";

/** Keep only the end of a stream so long-running processes stay bounded. */
export function appendExitOutputTail(existing: string, chunk: string): string {
  const combined = existing + chunk;
  return combined.length > MAX_EXIT_OUTPUT_CHARS
    ? combined.slice(combined.length - MAX_EXIT_OUTPUT_CHARS)
    : combined;
}

function errorTextFromEvent(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const record = event as Record<string, unknown>;

  const error = record.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }

  if (record.is_error === true || record.type === "error") {
    for (const key of ["result", "message", "subtype"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }

  return null;
}

function assistantTextFromEvent(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const record = event as Record<string, unknown>;
  if (record.type !== "assistant") return null;

  const content =
    record.message && typeof record.message === "object"
      ? (record.message as Record<string, unknown>).content
      : undefined;
  if (!Array.isArray(content)) return null;

  const text = content
    .flatMap((block) =>
      block &&
      typeof block === "object" &&
      (block as Record<string, unknown>).type === "text" &&
      typeof (block as Record<string, unknown>).text === "string"
        ? [(block as Record<string, unknown>).text as string]
        : [],
    )
    .join("\n")
    .trim();
  return text || null;
}

function elideRawTail(raw: string): string {
  return raw.length > MAX_RAW_TAIL_CHARS
    ? `${RAW_TAIL_ELISION}${raw.slice(raw.length - MAX_RAW_TAIL_CHARS)}`
    : raw;
}

interface StdoutFailure {
  structured: string;
  reported: string;
}

function extractStdoutError(stdoutTail: string): StdoutFailure {
  const structuredMessages: string[] = [];
  const reportedMessages: string[] = [];
  for (const line of stdoutTail.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const error = errorTextFromEvent(event);
      if (error) {
        structuredMessages.push(error);
        reportedMessages.push(error);
        continue;
      }
      const assistantText = assistantTextFromEvent(event);
      if (assistantText) reportedMessages.push(assistantText);
    } catch {
      // Not JSON: covered by the raw-tail fallback below.
    }
  }
  const structured = structuredMessages.join("\n");
  const reported = reportedMessages.join("\n");
  return {
    structured,
    reported: reported || elideRawTail(stdoutTail.trim()),
  };
}

export interface ChildProcessExitFailure {
  detail: string;
  /** CLI-authored error text suitable for permanent-error classification. */
  errorOutput: string;
}

/**
 * Describe a non-zero exit. The detail reports both streams, while
 * `errorOutput` excludes unstructured stdout that may merely quote an error.
 */
export function describeChildProcessExit(
  agentName: string,
  code: number | null,
  stdoutTail: string,
  stderr: string,
): ChildProcessExitFailure {
  const trimmedStderr = stderr.trim();
  const stdoutError = extractStdoutError(stdoutTail);
  const segments = [trimmedStderr, stdoutError.reported].filter(Boolean);
  return {
    detail:
      segments.length > 0
        ? `${agentName} exited with code ${code}: ${segments.join("\n")}`
        : `${agentName} exited with code ${code} and produced no output`,
    errorOutput: [trimmedStderr, stdoutError.structured]
      .filter(Boolean)
      .join("\n"),
  };
}

/**
 * Wire output collection, spawn-error handling, and the common close-handler
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
  let stdoutTail = "";

  child.stdout!.on("data", (data: Buffer) => {
    stdoutTail = appendExitOutputTail(stdoutTail, data.toString());
  });

  child.stderr!.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  child.on("error", (err) => {
    reject(new Error(`Failed to spawn ${agentName}: ${err.message}`));
  });

  child.on("close", (code) => {
    logStream?.end();
    if (code !== 0) {
      const failure = describeChildProcessExit(
        agentName,
        code,
        stdoutTail,
        stderr,
      );
      reject(new Error(failure.detail));
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
