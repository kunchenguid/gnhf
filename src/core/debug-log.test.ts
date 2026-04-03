import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendDebugLog } from "./debug-log.js";

describe("appendDebugLog", () => {
  const originalLogPath = process.env.GNHF_DEBUG_LOG_PATH;

  afterEach(() => {
    if (originalLogPath === undefined) {
      delete process.env.GNHF_DEBUG_LOG_PATH;
    } else {
      process.env.GNHF_DEBUG_LOG_PATH = originalLogPath;
    }
  });

  it("writes JSON lines when GNHF_DEBUG_LOG_PATH is set", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "gnhf-debug-log-test-"));
    const logPath = join(tempDir, "debug.jsonl");
    process.env.GNHF_DEBUG_LOG_PATH = logPath;

    appendDebugLog("run:start", { prompt: "ship it" });

    const [line] = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(JSON.parse(line!)).toMatchObject({
      event: "run:start",
      prompt: "ship it",
      pid: process.pid,
    });

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("does nothing when the env var is unset", () => {
    delete process.env.GNHF_DEBUG_LOG_PATH;

    expect(() =>
      appendDebugLog("run:start", { prompt: "ship it" }),
    ).not.toThrow();
  });
});
