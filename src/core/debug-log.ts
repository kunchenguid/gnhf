import { appendFileSync } from "node:fs";

export function appendDebugLog(
  event: string,
  details: Record<string, unknown> = {},
): void {
  const logPath = process.env.GNHF_DEBUG_LOG_PATH;
  if (!logPath) return;

  try {
    appendFileSync(
      logPath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        pid: process.pid,
        event,
        ...details,
      })}\n`,
      "utf-8",
    );
  } catch {
    // Debug logging is best-effort only.
  }
}
