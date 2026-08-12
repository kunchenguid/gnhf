import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  AgentLogFile,
  parseJSONLStream,
  setupAbortHandler,
  setupChildProcessHandlers,
} from "./stream-utils.js";

function createMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

function createMockReadable() {
  return new EventEmitter();
}

describe("AgentLogFile", () => {
  const tempDirs: string[] = [];

  function tempLogPath() {
    const dir = mkdtempSync(join(tmpdir(), "gnhf-log-"));
    tempDirs.push(dir);
    return join(dir, "iteration.jsonl");
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("keeps recording stdout that arrives after an aborted run finished", async () => {
    const logPath = tempLogPath();
    const logFile = new AgentLogFile(logPath);
    const child = createMockChild();
    const stdout = createMockReadable();
    logFile.track(child as never);
    parseJSONLStream(stdout as never, logFile, () => {});

    stdout.emit("data", Buffer.from('{"type":"before-abort"}\n'));
    // The abort path rejects the run while the child is still streaming.
    const closed = logFile.finish();
    stdout.emit("data", Buffer.from('{"type":"after-abort"}\n'));
    child.emit("close", 143);
    await closed;

    const written = readFileSync(logPath, "utf8");
    expect(written).toContain("before-abort");
    expect(written).toContain("after-abort");
  });

  it("stays open across a second spawn and closes once the last child exits", async () => {
    const logPath = tempLogPath();
    const logFile = new AgentLogFile(logPath);
    const first = createMockChild();
    logFile.track(first as never);
    logFile.write('{"turn":1}\n');
    first.emit("close", 0);

    const second = createMockChild();
    logFile.track(second as never);
    logFile.write('{"turn":2}\n');
    const closed = logFile.finish();
    second.emit("close", 0);
    await closed;

    const written = readFileSync(logPath, "utf8");
    expect(written).toContain('{"turn":1}');
    expect(written).toContain('{"turn":2}');

    // A late stdout chunk after the file closed must not raise
    // ERR_STREAM_WRITE_AFTER_END.
    expect(() => logFile.write('{"turn":"late"}\n')).not.toThrow();
    expect(readFileSync(logPath, "utf8")).not.toContain("late");
  });

  it("closes a run whose child failed to spawn", async () => {
    const logPath = tempLogPath();
    const logFile = new AgentLogFile(logPath);
    const child = createMockChild();
    logFile.track(child as never);
    logFile.write('{"spawn":"failed"}\n');

    child.emit("error", new Error("ENOENT"));
    await logFile.finish();

    expect(readFileSync(logPath, "utf8")).toContain('{"spawn":"failed"}');
  });
});

describe("parseJSONLStream", () => {
  it("parses complete JSONL events across chunk boundaries and writes chunks to the log", () => {
    const stream = createMockReadable();
    const logStream = { write: vi.fn() };
    const callback = vi.fn();

    parseJSONLStream<{ type: string; value?: number }>(
      stream as never,
      logStream as never,
      callback,
    );

    stream.emit("data", Buffer.from('{"type":"first"}\n{"typ'));
    stream.emit("data", Buffer.from('e":"second","value":2}\n'));

    expect(logStream.write).toHaveBeenNthCalledWith(
      1,
      Buffer.from('{"type":"first"}\n{"typ'),
    );
    expect(logStream.write).toHaveBeenNthCalledWith(
      2,
      Buffer.from('e":"second","value":2}\n'),
    );
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenNthCalledWith(1, { type: "first" });
    expect(callback).toHaveBeenNthCalledWith(2, {
      type: "second",
      value: 2,
    });
  });

  it("skips blank and invalid lines while continuing to parse later events", () => {
    const stream = createMockReadable();
    const callback = vi.fn();

    parseJSONLStream<{ ok: boolean }>(stream as never, null, callback);

    stream.emit(
      "data",
      Buffer.from('\nnot json\n{"ok":true}\n   \n{"ok":false}\n'),
    );

    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenNthCalledWith(1, { ok: true });
    expect(callback).toHaveBeenNthCalledWith(2, { ok: false });
  });
});

describe("setupChildProcessHandlers", () => {
  it("rejects with stderr content when the process exits non-zero", () => {
    const child = createMockChild();
    const reject = vi.fn();
    const onSuccess = vi.fn();

    setupChildProcessHandlers(child as never, "codex", reject, onSuccess);

    child.stderr.emit("data", Buffer.from("boom"));
    child.emit("close", 2);

    expect(onSuccess).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledWith(
      new Error("codex exited with code 2: boom"),
    );
  });

  it("wraps spawn errors and resolves successful exits through the success callback", () => {
    const child = createMockChild();
    const reject = vi.fn();
    const onSuccess = vi.fn();

    setupChildProcessHandlers(child as never, "rovodev", reject, onSuccess);

    child.emit("error", new Error("ENOENT"));
    expect(reject).toHaveBeenCalledWith(
      new Error("Failed to spawn rovodev: ENOENT"),
    );

    child.emit("close", 0);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});

describe("setupAbortHandler", () => {
  it("returns false when no signal is provided", () => {
    const child = createMockChild();

    expect(setupAbortHandler(undefined, child as never, vi.fn())).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("kills immediately and rejects when the signal is already aborted", () => {
    const controller = new AbortController();
    controller.abort();
    const child = createMockChild();
    const reject = vi.fn();

    const handled = setupAbortHandler(
      controller.signal,
      child as never,
      reject,
    );

    expect(handled).toBe(true);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(reject).toHaveBeenCalledWith(new Error("Agent was aborted"));
  });

  it("kills once on abort and removes the listener after the process closes", () => {
    const controller = new AbortController();
    const child = createMockChild();
    const reject = vi.fn();

    const handled = setupAbortHandler(
      controller.signal,
      child as never,
      reject,
    );
    expect(handled).toBe(false);

    controller.abort();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(reject).toHaveBeenCalledWith(new Error("Agent was aborted"));

    child.emit("close", 0);
    controller.abort();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
