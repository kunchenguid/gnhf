import { beforeEach, describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

import { execFileSync, spawn } from "node:child_process";
import { CursorAgent } from "./cursor.js";
import { buildAgentOutputSchema, PermanentAgentError } from "./types.js";

const mockSpawn = vi.mocked(spawn);

function createMockProcess() {
  const stdin = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
  });
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin,
    kill: vi.fn(),
  });
  return proc as typeof proc & ReturnType<typeof spawn>;
}

function emitJson(proc: ReturnType<typeof createMockProcess>, event: unknown) {
  proc.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
}

function withTemporaryPath(candidates: string[], callback: () => void): void {
  const directory = mkdtempSync(join(tmpdir(), "gnhf-cursor-path-"));
  const originalPath = process.env.PATH;
  try {
    for (const candidate of candidates) {
      const path = join(directory, candidate);
      writeFileSync(path, "");
      chmodSync(path, 0o755);
    }
    process.env.PATH = directory;
    callback();
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("CursorAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execFileSync).mockReset();
  });

  it("has the cursor agent name", () => {
    expect(new CursorAgent().name).toBe("cursor");
  });

  it.each([
    [["cursor-agent"], "cursor-agent"],
    [["agent"], "agent"],
    [[], "cursor-agent"],
  ] as const)(
    "resolves PATH candidates %j to %s",
    (candidates, expectedBin) => {
      withTemporaryPath([...candidates], () => {
        const proc = createMockProcess();
        mockSpawn.mockReturnValue(proc);

        new CursorAgent({ platform: process.platform }).run(
          "test prompt",
          "/work/dir",
        );

        expect(mockSpawn).toHaveBeenCalledWith(
          expectedBin,
          expect.arrayContaining(["-p"]),
          expect.objectContaining({ cwd: "/work/dir" }),
        );
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "falls back when cursor-agent is not executable",
    () => {
      withTemporaryPath(["cursor-agent", "agent"], () => {
        const directory = process.env.PATH!;
        chmodSync(join(directory, "cursor-agent"), 0o644);
        const proc = createMockProcess();
        mockSpawn.mockReturnValue(proc);

        new CursorAgent({ platform: "linux" }).run("test prompt", "/work/dir");

        expect(mockSpawn).toHaveBeenCalledWith(
          "agent",
          expect.arrayContaining(["-p"]),
          expect.objectContaining({ cwd: "/work/dir" }),
        );
      });
    },
  );

  it("spawns cursor-agent in print stream-json mode with force, trust, and approve-mcps defaults", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent({ platform: "linux" });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "cursor-agent",
      [
        "-p",
        "--output-format",
        "stream-json",
        "--force",
        "--trust",
        "--approve-mcps",
      ],
      {
        cwd: "/work/dir",
        detached: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      },
    );
    expect(proc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining("test prompt"),
    );
    expect(proc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining("gnhf final output contract"),
    );
    expect(proc.stdin.end).toHaveBeenCalled();
  });

  it("uses a shell on Windows for cmd wrapper paths", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent({
      bin: "C:\\tools\\agent.cmd",
      platform: "win32",
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "C:\\tools\\agent.cmd",
      expect.any(Array),
      expect.objectContaining({ shell: true, detached: false }),
    );
  });

  it("uses a shell on Windows when a bare override resolves to a cmd wrapper", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    vi.mocked(execFileSync).mockReturnValue(
      "C:\\tools\\cursor-switch.cmd\r\n" as never,
    );
    const agent = new CursorAgent({
      bin: "cursor-switch",
      platform: "win32",
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "cursor-switch",
      expect.any(Array),
      expect.objectContaining({ shell: true }),
    );
  });

  it("passes configured extra args through and suppresses default force when user-managed", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent({
      extraArgs: ["--model", "composer-2", "--yolo"],
    });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args.slice(0, 3)).toEqual(["--model", "composer-2", "--yolo"]);
    expect(args).not.toContain("--force");
    expect(args).toContain("--trust");
    expect(args).toContain("--approve-mcps");
  });

  it("keeps default force when user only sets --sandbox", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent({
      extraArgs: ["--sandbox=enabled"],
    });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args).toEqual([
      "--sandbox=enabled",
      "-p",
      "--output-format",
      "stream-json",
      "--force",
      "--trust",
      "--approve-mcps",
    ]);
  });

  it("suppresses default trust when the user already set it", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent({
      extraArgs: ["--trust"],
    });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args.filter((arg) => arg === "--trust")).toHaveLength(1);
    expect(args).toContain("--force");
    expect(args).toContain("--approve-mcps");
  });

  it("suppresses default approve-mcps when the user already set it", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent({
      extraArgs: ["--approve-mcps"],
    });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args.filter((arg) => arg === "--approve-mcps")).toHaveLength(1);
    expect(args).toContain("--force");
    expect(args).toContain("--trust");
  });

  it("kills the full process tree on Windows when aborted", async () => {
    const proc = createMockProcess();
    Object.defineProperty(proc, "pid", { value: 6789 });
    mockSpawn.mockReturnValue(proc);
    const controller = new AbortController();
    const agent = new CursorAgent({ platform: "win32" });

    const promise = agent.run("test prompt", "/work/dir", {
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).rejects.toThrow("Agent was aborted");
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      "taskkill",
      ["/T", "/F", "/PID", "6789"],
      { stdio: "ignore" },
    );
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("parses the last assistant text and reports usage from the result event", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onMessage = vi.fn();
    const onUsage = vi.fn();
    const agent = new CursorAgent();
    const draft = JSON.stringify({
      success: true,
      summary: "stale",
      key_changes_made: ["old"],
      key_learnings: ["old"],
    });
    const content = JSON.stringify({
      success: true,
      summary: "ok",
      key_changes_made: ["a"],
      key_learnings: ["b"],
    });

    const promise = agent.run("test prompt", "/work/dir", {
      onMessage,
      onUsage,
    });
    emitJson(proc, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "working..." }],
      },
    });
    emitJson(proc, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: content }],
      },
    });
    emitJson(proc, {
      type: "result",
      subtype: "success",
      is_error: false,
      result: `${draft}${content}`,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 80,
        cacheWriteTokens: 5,
      },
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toEqual({
      output: {
        success: true,
        summary: "ok",
        key_changes_made: ["a"],
        key_learnings: ["b"],
      },
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 80,
        cacheCreationTokens: 5,
      },
    });
    expect(onMessage).toHaveBeenCalledWith("working...");
    expect(onMessage).toHaveBeenCalledWith(content);
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      cacheCreationTokens: 5,
    });
  });

  it("rejects stale structured output when the last assistant message is prose", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();
    const stale = JSON.stringify({
      success: true,
      summary: "stale",
      key_changes_made: ["old"],
      key_learnings: ["old"],
    });

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: stale }],
      },
    });
    emitJson(proc, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "could not finish" }],
      },
    });
    emitJson(proc, {
      type: "result",
      subtype: "success",
      result: `${stale}could not finish`,
    });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("Failed to parse cursor output");
  });

  it("falls back to result text when no assistant message is present", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onMessage = vi.fn();
    const agent = new CursorAgent();
    const content = JSON.stringify({
      success: true,
      summary: "ok",
      key_changes_made: [],
      key_learnings: [],
    });

    const promise = agent.run("test prompt", "/work/dir", { onMessage });
    emitJson(proc, {
      type: "result",
      subtype: "success",
      result: content,
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: {
        success: true,
        summary: "ok",
      },
    });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("accepts a fenced JSON final answer", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "result",
      subtype: "success",
      result:
        '```json\n{"success":true,"summary":"ok","key_changes_made":[],"key_learnings":[]}\n```',
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: {
        success: true,
        summary: "ok",
      },
    });
  });

  it("recovers JSON when cursor prepends prose before the final object", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "result",
      subtype: "success",
      result:
        'Done.\n\n{"success":true,"summary":"ok","key_changes_made":[],"key_learnings":[]}',
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: {
        success: true,
        summary: "ok",
      },
    });
  });

  it("includes should_fully_stop in the prompt contract when the schema requires it", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent({
      schema: buildAgentOutputSchema({ includeStopField: true }),
    });

    agent.run("test prompt", "/work/dir");

    expect(proc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining("should_fully_stop"),
    );
  });

  it("rejects when cursor returns no text output", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("cursor returned no text output");
  });

  it("rejects when the result event reports an error", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "result",
      subtype: "error",
      is_error: true,
      result: "auth failed",
    });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("auth failed");
  });

  it("reports a signed-out cursor exit as permanent so it does not burn retries", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    proc.stderr.emit(
      "data",
      Buffer.from(
        "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.\n",
      ),
    );
    proc.emit("close", 1);

    await expect(promise).rejects.toThrow(PermanentAgentError);
    await expect(promise).rejects.toThrow("cursor is not signed in");
  });

  it("reports a signed-out cursor result event as permanent", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "result",
      subtype: "error",
      is_error: true,
      result: "Authentication required. Please run 'agent login' first.",
    });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow(PermanentAgentError);
  });

  it("keeps an ordinary non-zero exit retryable", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    proc.stderr.emit("data", Buffer.from("upstream provider is overloaded\n"));
    proc.emit("close", 1);

    await expect(promise).rejects.toThrow("cursor exited with code 1");
    await expect(promise).rejects.not.toThrow(PermanentAgentError);
  });

  it("shuts down a lingering cursor process after a non-error result", async () => {
    vi.useFakeTimers();
    const processKill = vi
      .spyOn(process, "kill")
      .mockImplementation(() => true);
    try {
      const proc = createMockProcess();
      Object.defineProperty(proc, "pid", { value: 4321 });
      mockSpawn.mockReturnValue(proc);
      const agent = new CursorAgent({
        finalResultGraceMs: 25,
        platform: "darwin",
      });
      const content = JSON.stringify({
        success: true,
        summary: "done",
        key_changes_made: [],
        key_learnings: [],
      });

      const promise = agent.run("test prompt", "/work/dir");
      emitJson(proc, {
        type: "result",
        subtype: "success",
        is_error: false,
        result: content,
      });

      await vi.advanceTimersByTimeAsync(24);
      expect(processKill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(processKill).toHaveBeenCalledWith(-4321, "SIGTERM");

      proc.emit("close", null);
      await expect(promise).resolves.toMatchObject({
        output: { success: true, summary: "done" },
      });
    } finally {
      processKill.mockRestore();
      vi.useRealTimers();
    }
  });

  it("force kills cursor if it ignores the final-result shutdown signal", async () => {
    vi.useFakeTimers();
    const processKill = vi
      .spyOn(process, "kill")
      .mockImplementation((pid, signal) => {
        if (pid === -4321 && signal === "SIGKILL") {
          queueMicrotask(() => {
            proc.emit("close", null);
          });
        }
        return true;
      });
    const proc = createMockProcess();
    Object.defineProperty(proc, "pid", { value: 4321 });
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent({
      finalResultGraceMs: 25,
      platform: "darwin",
    });
    const content = JSON.stringify({
      success: true,
      summary: "done",
      key_changes_made: [],
      key_learnings: [],
    });

    try {
      const promise = agent.run("test prompt", "/work/dir");
      emitJson(proc, {
        type: "result",
        subtype: "success",
        is_error: false,
        result: content,
      });

      await vi.advanceTimersByTimeAsync(25);
      expect(processKill).toHaveBeenCalledWith(-4321, "SIGTERM");

      await vi.advanceTimersByTimeAsync(2_999);
      expect(processKill).not.toHaveBeenCalledWith(-4321, "SIGKILL");

      await vi.advanceTimersByTimeAsync(1);
      expect(processKill).toHaveBeenCalledWith(-4321, "SIGKILL");

      await expect(promise).resolves.toMatchObject({
        output: { success: true, summary: "done" },
      });
    } finally {
      processKill.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not schedule linger cleanup for error results", async () => {
    vi.useFakeTimers();
    const processKill = vi
      .spyOn(process, "kill")
      .mockImplementation(() => true);
    try {
      const proc = createMockProcess();
      Object.defineProperty(proc, "pid", { value: 4321 });
      mockSpawn.mockReturnValue(proc);
      const agent = new CursorAgent({
        finalResultGraceMs: 25,
        platform: "darwin",
      });

      const promise = agent.run("test prompt", "/work/dir");
      emitJson(proc, {
        type: "result",
        subtype: "error",
        is_error: true,
        result: "auth failed",
      });

      await vi.advanceTimersByTimeAsync(25);
      expect(processKill).not.toHaveBeenCalled();

      proc.emit("close", 0);
      await expect(promise).rejects.toThrow("auth failed");
    } finally {
      processKill.mockRestore();
      vi.useRealTimers();
    }
  });

  it("rejects when the final answer is not valid JSON", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "result",
      subtype: "success",
      result: "not json",
    });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("Failed to parse cursor output");
  });

  it("rejects when the final answer misses required fields", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "result",
      subtype: "success",
      result: '{"success":true,"summary":"ok"}',
    });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("Failed to parse cursor output");
  });
});
