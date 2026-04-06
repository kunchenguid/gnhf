import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendDebugLog,
  initDebugLog,
  resetDebugLogForTests,
  serializeError,
} from "./debug-log.js";

function readLines(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("debug-log", () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(() => {
    resetDebugLogForTests();
    tempDir = mkdtempSync(join(tmpdir(), "gnhf-debug-log-test-"));
    logPath = join(tempDir, "gnhf.log");
  });

  afterEach(() => {
    resetDebugLogForTests();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes JSON lines to the initialized log path", () => {
    initDebugLog(logPath);
    appendDebugLog("run:start", { prompt: "ship it" });

    const [line] = readLines(logPath);
    expect(line).toMatchObject({
      event: "run:start",
      prompt: "ship it",
      pid: process.pid,
    });
    expect(typeof line!.timestamp).toBe("string");
  });

  it("creates the parent directory if missing", () => {
    const nestedLogPath = join(tempDir, "nested", "deeper", "gnhf.log");
    initDebugLog(nestedLogPath);
    appendDebugLog("run:start");
    expect(readLines(nestedLogPath)).toHaveLength(1);
  });

  it("appends to an existing log file across multiple writes", () => {
    initDebugLog(logPath);
    appendDebugLog("iteration:start", { iteration: 1 });
    appendDebugLog("iteration:end", { iteration: 1, success: true });

    const lines = readLines(logPath);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ event: "iteration:start", iteration: 1 });
    expect(lines[1]).toMatchObject({ event: "iteration:end", success: true });
  });

  it("buffers events emitted before init and flushes them on init", () => {
    appendDebugLog("sleep:active", { command: "caffeinate" });
    appendDebugLog("opencode:spawn", { port: 12345 });

    // Nothing should be written yet — no log path known.
    expect(existsSync(logPath)).toBe(false);

    initDebugLog(logPath);
    appendDebugLog("run:start");

    const events = readLines(logPath).map((entry) => entry.event);
    expect(events).toEqual(["sleep:active", "opencode:spawn", "run:start"]);
  });

  it("drops the oldest pre-init events when the buffer fills up and records a sentinel", () => {
    // 1005 events — the first 5 should be dropped when capacity (1000) is exceeded.
    for (let i = 0; i < 1005; i += 1) {
      appendDebugLog("pre-init", { i });
    }

    initDebugLog(logPath);
    const lines = readLines(logPath);
    // 1 sentinel + 1000 retained events.
    expect(lines).toHaveLength(1001);
    expect(lines[0]).toMatchObject({
      event: "debug-log:pre-init-overflow",
      droppedCount: 5,
      bufferCapacity: 1000,
    });
    expect(lines[1]).toMatchObject({ event: "pre-init", i: 5 });
    expect(lines[1000]).toMatchObject({ event: "pre-init", i: 1004 });
  });

  it("does not throw when the log file cannot be written", () => {
    // Put a regular file where the log's parent directory would need to be,
    // so mkdirSync recursive fails with ENOTDIR / EEXIST.
    const blockingFile = join(tempDir, "block");
    writeFileSync(blockingFile, "not a directory");
    const doomedLogPath = join(blockingFile, "child", "gnhf.log");

    expect(() => initDebugLog(doomedLogPath)).not.toThrow();
    expect(() => appendDebugLog("run:start")).not.toThrow();
    // The log file obviously does not exist, since its parent can't be a directory.
    expect(existsSync(doomedLogPath)).toBe(false);
  });

  it("does not throw when details contain a BigInt", () => {
    initDebugLog(logPath);
    expect(() =>
      appendDebugLog("stat", { count: 9_007_199_254_740_993n }),
    ).not.toThrow();

    const [line] = readLines(logPath);
    // BigInt made JSON.stringify fail, so we fall back to the minimal line
    // that at least records the event name and which keys were present.
    expect(line).toMatchObject({
      event: "stat",
      logError: expect.stringMatching(/BigInt/),
      detailsKeys: ["count"],
    });
  });

  it("does not throw when details contain a circular reference", () => {
    initDebugLog(logPath);
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => appendDebugLog("stat", { circular })).not.toThrow();

    const [line] = readLines(logPath);
    expect(line).toMatchObject({
      event: "stat",
      logError: expect.stringMatching(/circular/i),
      detailsKeys: ["circular"],
    });
  });

  it("does not throw when details contain an object with a throwing getter", () => {
    initDebugLog(logPath);
    const hostile = {};
    Object.defineProperty(hostile, "boom", {
      enumerable: true,
      get() {
        throw new Error("getter exploded");
      },
    });
    expect(() => appendDebugLog("stat", { hostile })).not.toThrow();

    const [line] = readLines(logPath);
    expect(line).toMatchObject({
      event: "stat",
      logError: expect.stringMatching(/getter exploded/),
    });
  });
});

describe("serializeError", () => {
  it("captures name, message, code, and a truncated stack", () => {
    const error = new Error("boom");
    (error as { code?: string }).code = "E_BAD";
    const serialized = serializeError(error);
    expect(serialized).toMatchObject({
      name: "Error",
      message: "boom",
      code: "E_BAD",
    });
    expect(typeof serialized.stack).toBe("string");
    expect((serialized.stack as string).split("\n").length).toBeLessThanOrEqual(
      12,
    );
  });

  it("unwinds the cause chain (e.g. TypeError: fetch failed → undici cause)", () => {
    const cause = new Error("other side closed");
    (cause as { code?: string }).code = "UND_ERR_SOCKET";
    const wrapped = new TypeError("fetch failed", { cause });

    const serialized = serializeError(wrapped);

    expect(serialized).toMatchObject({
      name: "TypeError",
      message: "fetch failed",
      cause: {
        name: "Error",
        message: "other side closed",
        code: "UND_ERR_SOCKET",
      },
    });
  });

  it("truncates deeply nested cause chains", () => {
    let error: Error = new Error("leaf");
    for (let i = 0; i < 12; i += 1) {
      error = new Error(`level ${i}`, { cause: error });
    }

    const serialized = serializeError(error);

    // Walk down the cause chain and verify it eventually truncates.
    let node: Record<string, unknown> | undefined = serialized;
    let depth = 0;
    while (node && typeof node === "object" && "cause" in node) {
      node = node.cause as Record<string, unknown>;
      depth += 1;
      if (depth > 20) throw new Error("cause chain did not terminate");
    }
    expect(node).toMatchObject({ value: "[cause chain truncated]" });
  });

  it("handles non-Error values", () => {
    expect(serializeError("just a string")).toEqual({ value: "just a string" });
    expect(serializeError(42)).toEqual({ value: "42" });
    expect(serializeError(null)).toEqual({ value: "null" });
    expect(serializeError(undefined)).toEqual({ value: "undefined" });
    expect(serializeError({ foo: "bar" })).toEqual({ value: { foo: "bar" } });
  });

  it("does not throw on Errors with throwing getters", () => {
    // An Error subclass that explodes when its message/stack are read.
    // Without defensive reads this would propagate out of the catch block
    // inside orchestrator.runIteration and mask the original agent error.
    class HostileError extends Error {
      override get message(): string {
        throw new Error("message getter exploded");
      }
      override get stack(): string {
        throw new Error("stack getter exploded");
      }
    }
    const hostile = new HostileError();

    expect(() => serializeError(hostile)).not.toThrow();
    const serialized = serializeError(hostile);
    // We should still get the error name — everything else falls back safely.
    expect(serialized).toMatchObject({ name: "Error" });
  });

  it("does not throw on Errors whose cause chain contains throwing getters", () => {
    class HostileCause extends Error {
      override get message(): string {
        throw new Error("boom");
      }
    }
    const wrapped = new Error("wrapper", { cause: new HostileCause() });
    expect(() => serializeError(wrapped)).not.toThrow();
    const serialized = serializeError(wrapped);
    expect(serialized).toMatchObject({
      name: "Error",
      message: "wrapper",
      cause: expect.objectContaining({ name: "Error" }),
    });
  });
});
