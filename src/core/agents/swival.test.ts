import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

import { execFileSync, spawn } from "node:child_process";
import { SwivalAgent } from "./swival.js";
import { buildAgentOutputSchema } from "./types.js";

const mockSpawn = vi.mocked(spawn);

function createMockProcess() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: {
      write: vi.fn(),
      end: vi.fn(),
    },
    kill: vi.fn(),
  });
  return proc as typeof proc & ReturnType<typeof spawn>;
}

function emitStdout(proc: ReturnType<typeof createMockProcess>, chunk: string) {
  proc.stdout.emit("data", Buffer.from(chunk));
}

function finalOutput(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    success: true,
    summary: "ok",
    key_changes_made: [],
    key_learnings: [],
    ...extra,
  });
}

describe("SwivalAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has the swival agent name", () => {
    expect(new SwivalAgent().name).toBe("swival");
  });

  it("spawns swival in quiet mode with --yolo by default and pipes the prompt on stdin", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new SwivalAgent();

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "swival",
      ["--yolo", "--no-color", "-q"],
      {
        cwd: "/work/dir",
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
        detached: true,
      },
    );
    expect(proc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining("test prompt"),
    );
    expect(proc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining("gnhf final output contract"),
    );
    expect(proc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining("key_changes_made"),
    );
    expect(proc.stdin.end).toHaveBeenCalled();
  });

  it("passes user extra args through and skips --yolo when the user picked a permission mode", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new SwivalAgent({
      extraArgs: ["--provider", "openrouter", "--files", "all"],
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "swival",
      ["--provider", "openrouter", "--files", "all", "--no-color", "-q"],
      expect.any(Object),
    );
  });

  it("uses a custom binary path", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new SwivalAgent({ bin: "/custom/swival" });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "/custom/swival",
      expect.any(Array),
      expect.any(Object),
    );
  });

  it("uses a shell on Windows for cmd wrapper paths", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new SwivalAgent({
      bin: "C:\\tools\\swival.cmd",
      platform: "win32",
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "C:\\tools\\swival.cmd",
      expect.any(Array),
      expect.objectContaining({ shell: true }),
    );
  });

  it("uses a shell on Windows when a bare override resolves to a cmd wrapper", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    vi.mocked(execFileSync).mockReturnValue(
      "C:\\tools\\swival.cmd\r\n" as never,
    );
    const agent = new SwivalAgent({
      bin: "swival-switch",
      platform: "win32",
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "swival-switch",
      expect.any(Array),
      expect.objectContaining({ shell: true }),
    );
  });

  it("kills the full process tree on Windows when aborted", async () => {
    const proc = createMockProcess();
    Object.defineProperty(proc, "pid", { value: 4321 });
    mockSpawn.mockReturnValue(proc);
    const controller = new AbortController();
    const agent = new SwivalAgent({ platform: "win32" });

    const promise = agent.run("test prompt", "/work/dir", {
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).rejects.toThrow("Agent was aborted");
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      "taskkill",
      ["/T", "/F", "/PID", "4321"],
      { stdio: "ignore" },
    );
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("signals the whole process group on POSIX when aborted", async () => {
    const proc = createMockProcess();
    Object.defineProperty(proc, "pid", { value: 7777 });
    mockSpawn.mockReturnValue(proc);
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      const controller = new AbortController();
      const agent = new SwivalAgent({ platform: "linux" });

      const promise = agent.run("test prompt", "/work/dir", {
        signal: controller.signal,
      });
      controller.abort();

      await expect(promise).rejects.toThrow("Agent was aborted");
      expect(killSpy).toHaveBeenCalledWith(-7777, "SIGTERM");
      expect(proc.kill).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it("parses the buffered stdout as the final JSON answer", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onMessage = vi.fn();
    const agent = new SwivalAgent();

    const promise = agent.run("test prompt", "/work/dir", { onMessage });
    emitStdout(proc, finalOutput());
    proc.emit("close", 0);

    await expect(promise).resolves.toEqual({
      output: {
        success: true,
        summary: "ok",
        key_changes_made: [],
        key_learnings: [],
      },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    });
    expect(onMessage).toHaveBeenCalledWith(finalOutput());
  });

  it("strips a Markdown JSON fence around the final answer", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new SwivalAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitStdout(proc, "```json\n");
    emitStdout(proc, finalOutput());
    emitStdout(proc, "\n```\n");
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { success: true, summary: "ok" },
    });
  });

  it("requires should_fully_stop when the schema includes it", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new SwivalAgent({
      schema: buildAgentOutputSchema({ includeStopField: true }),
    });

    const promise = agent.run("test prompt", "/work/dir");
    emitStdout(proc, finalOutput());
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("Invalid swival output");
  });

  it("resolves when should_fully_stop is present for stop-field schemas", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new SwivalAgent({
      schema: buildAgentOutputSchema({ includeStopField: true }),
    });

    const promise = agent.run("test prompt", "/work/dir");
    emitStdout(proc, finalOutput({ should_fully_stop: true }));
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { should_fully_stop: true },
    });
  });

  it("requires commit fields when the schema includes them", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new SwivalAgent({
      schema: buildAgentOutputSchema({
        includeStopField: false,
        commitFields: [{ name: "commit_type", allowed: ["feat", "fix"] }],
      }),
    });

    const promise = agent.run("test prompt", "/work/dir");
    emitStdout(proc, finalOutput());
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("Invalid swival output");
  });

  it("rejects empty stdout", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new SwivalAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitStdout(proc, "   \n");
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("swival returned no output");
  });

  it("rejects malformed JSON", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new SwivalAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitStdout(proc, "not json");
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("Failed to parse swival output");
  });

  it("rejects invalid output shape", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new SwivalAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitStdout(
      proc,
      JSON.stringify({
        success: "yes",
        summary: "ok",
        key_changes_made: [],
        key_learnings: [],
      }),
    );
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("Invalid swival output");
  });

  it("rejects spawn errors", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new SwivalAgent();

    const promise = agent.run("test prompt", "/work/dir");
    proc.emit("error", new Error("ENOENT"));

    await expect(promise).rejects.toThrow("Failed to spawn swival: ENOENT");
  });

  it("rejects non-zero exits with stderr", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new SwivalAgent();

    const promise = agent.run("test prompt", "/work/dir");
    proc.stderr.emit("data", Buffer.from("provider error"));
    proc.emit("close", 3);

    await expect(promise).rejects.toThrow(
      "swival exited with code 3: provider error",
    );
  });
});
