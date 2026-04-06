import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Bounded in-memory buffer so events emitted before a run's log file is
// known (e.g. sleep-prevention spawn events) aren't lost. Flushed to disk
// once initDebugLog is called.
const PRE_INIT_BUFFER_CAPACITY = 1000;
const STACK_LINE_LIMIT = 12;
const CAUSE_DEPTH_LIMIT = 6;

let logPath: string | null = null;
let preInitBuffer: string[] = [];
let preInitDroppedCount = 0;

function formatLine(event: string, details: Record<string, unknown>): string {
  const base = {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    event,
  };
  // Logging is best-effort and runs from timer callbacks, EventEmitter
  // handlers, and error paths — throwing here would turn diagnostic output
  // into an uncaught exception. JSON.stringify can throw on BigInts,
  // circular references, or Error subclasses with throwing getters, so we
  // fall back to a minimal line that at least records the event name.
  try {
    return `${JSON.stringify({ ...base, ...details })}\n`;
  } catch (error) {
    return `${JSON.stringify({
      ...base,
      logError:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
      detailsKeys: Object.keys(details),
    })}\n`;
  }
}

export function initDebugLog(path: string): void {
  logPath = path;
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // Best-effort: the directory usually already exists.
  }

  if (preInitBuffer.length === 0 && preInitDroppedCount === 0) return;

  // If any events were dropped while the buffer was full, prepend a sentinel
  // so the log makes it obvious that early events are missing instead of
  // silently losing them.
  const droppedSentinel =
    preInitDroppedCount > 0
      ? formatLine("debug-log:pre-init-overflow", {
          droppedCount: preInitDroppedCount,
          bufferCapacity: PRE_INIT_BUFFER_CAPACITY,
        })
      : "";
  const flushed = droppedSentinel + preInitBuffer.join("");
  preInitBuffer = [];
  preInitDroppedCount = 0;
  try {
    appendFileSync(path, flushed, "utf-8");
  } catch {
    // Debug logging is best-effort only.
  }
}

export function appendDebugLog(
  event: string,
  details: Record<string, unknown> = {},
): void {
  const line = formatLine(event, details);

  if (logPath === null) {
    preInitBuffer.push(line);
    if (preInitBuffer.length > PRE_INIT_BUFFER_CAPACITY) {
      preInitBuffer.shift();
      preInitDroppedCount += 1;
    }
    return;
  }

  try {
    appendFileSync(logPath, line, "utf-8");
  } catch {
    // Debug logging is best-effort only.
  }
}

/**
 * Serialize an error (including its cause chain) to a plain object that's
 * safe to embed in a JSONL log line. This is critical for diagnosing
 * fetch failures, where the surface message is often just "fetch failed"
 * but `err.cause` holds the real undici error (e.g. UND_ERR_HEADERS_TIMEOUT).
 *
 * Contract: must never throw. Callers invoke this inside catch blocks and
 * timer/EventEmitter handlers, and a throw here would mask the original
 * error or crash the process.
 */
export function serializeError(
  error: unknown,
  depth = 0,
): Record<string, unknown> {
  try {
    return serializeErrorUnsafe(error, depth);
  } catch (serializationError) {
    return {
      value: "[serialization failed]",
      serializationError:
        serializationError instanceof Error
          ? `${serializationError.name}: ${serializationError.message}`
          : String(serializationError),
    };
  }
}

function tryRead<T>(read: () => T): T | undefined {
  // Error subclasses can expose properties as getters that throw (e.g.
  // lazily computed stack traces that hit the filesystem). Swallow those
  // so serialization keeps going.
  try {
    return read();
  } catch {
    return undefined;
  }
}

function serializeErrorUnsafe(
  error: unknown,
  depth: number,
): Record<string, unknown> {
  if (depth > CAUSE_DEPTH_LIMIT) {
    return { value: "[cause chain truncated]" };
  }

  if (error instanceof Error) {
    const result: Record<string, unknown> = {
      name: tryRead(() => error.name) ?? "Error",
      message: tryRead(() => error.message) ?? "",
    };
    const code = tryRead(() => (error as { code?: unknown }).code);
    if (typeof code === "string" || typeof code === "number") {
      result.code = code;
    }
    const stack = tryRead(() => error.stack);
    if (typeof stack === "string") {
      result.stack = stack.split("\n").slice(0, STACK_LINE_LIMIT).join("\n");
    }
    const cause = tryRead(() => ("cause" in error ? error.cause : undefined));
    if (cause !== undefined) {
      result.cause = serializeError(cause, depth + 1);
    }
    return result;
  }

  if (error === null || error === undefined) {
    return { value: String(error) };
  }

  if (typeof error === "object") {
    try {
      return { value: JSON.parse(JSON.stringify(error)) as unknown };
    } catch {
      return { value: String(error) };
    }
  }

  return { value: String(error) };
}

/** Test-only: reset module state between tests. */
export function resetDebugLogForTests(): void {
  logPath = null;
  preInitBuffer = [];
  preInitDroppedCount = 0;
}
