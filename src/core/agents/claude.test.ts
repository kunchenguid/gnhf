import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

import { execFileSync, spawn } from "node:child_process";
import { ClaudeAgent } from "./claude.js";

const mockSpawn = vi.mocked(spawn);

function createMockProcess() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: null,
    kill: vi.fn(),
  });
  return proc as typeof proc & ReturnType<typeof spawn>;
}

function emitLine(proc: ReturnType<typeof createMockProcess>, obj: unknown) {
  proc.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
}

describe("ClaudeAgent", () => {
  let agent: ClaudeAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new ClaudeAgent();
  });

  it("has name 'claude'", () => {
    expect(agent.name).toBe("claude");
  });

  it("spawns claude with stream-json output format", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      [
        "-p",
        "test prompt",
        "--verbose",
        "--output-format",
        "stream-json",
        "--json-schema",
        expect.any(String),
        "--dangerously-skip-permissions",
      ],
      {
        cwd: "/work/dir",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );
  });

  it("does not use a shell for direct Windows launches", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const windowsAgent = new ClaudeAgent({
      platform: "win32",
    });

    windowsAgent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      [
        "-p",
        "test prompt",
        "--verbose",
        "--output-format",
        "stream-json",
        "--json-schema",
        expect.any(String),
        "--dangerously-skip-permissions",
      ],
      {
        cwd: "/work/dir",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );
  });

  it("uses a shell on Windows for cmd wrapper paths", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const windowsAgent = new ClaudeAgent({
      bin: "C:\\tools\\claude.cmd",
      platform: "win32",
    });

    windowsAgent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "C:\\tools\\claude.cmd",
      [
        "-p",
        "test prompt",
        "--verbose",
        "--output-format",
        "stream-json",
        "--json-schema",
        expect.any(String),
        "--dangerously-skip-permissions",
      ],
      {
        cwd: "/work/dir",
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );
  });

  it("uses a shell on Windows when a bare override resolves to a cmd wrapper", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    vi.mocked(execFileSync).mockReturnValue(
      "C:\\tools\\claude-code-switch.cmd\r\n" as never,
    );
    const windowsAgent = new ClaudeAgent({
      bin: "claude-code-switch",
      platform: "win32",
    });

    windowsAgent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude-code-switch",
      [
        "-p",
        "test prompt",
        "--verbose",
        "--output-format",
        "stream-json",
        "--json-schema",
        expect.any(String),
        "--dangerously-skip-permissions",
      ],
      {
        cwd: "/work/dir",
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );
  });

  it("passes configured extra args through to claude", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const configuredAgent = new ClaudeAgent({
      extraArgs: ["--model", "sonnet", "--permission-mode=plan"],
    });

    configuredAgent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      [
        "--model",
        "sonnet",
        "--permission-mode=plan",
        "-p",
        "test prompt",
        "--verbose",
        "--output-format",
        "stream-json",
        "--json-schema",
        expect.any(String),
      ],
      expect.any(Object),
    );
  });

  it("kills the full process tree on Windows when aborted", async () => {
    const proc = createMockProcess();
    Object.defineProperty(proc, "pid", { value: 5678 });
    mockSpawn.mockReturnValue(proc);
    const controller = new AbortController();
    const windowsAgent = new ClaudeAgent({
      platform: "win32",
    });

    const promise = windowsAgent.run("test prompt", "/work/dir", {
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).rejects.toThrow("Agent was aborted");
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      "taskkill",
      ["/T", "/F", "/PID", "5678"],
      { stdio: "ignore" },
    );
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("resolves with parsed output and usage on success", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");

    emitLine(proc, {
      type: "assistant",
      message: {
        usage: {
          input_tokens: 100,
          output_tokens: 200,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 10,
        },
      },
    });

    emitLine(proc, {
      type: "result",
      subtype: "success",
      is_error: false,
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 10,
        output_tokens: 200,
      },
      structured_output: {
        success: true,
        summary: "done",
        key_changes_made: ["a"],
        key_learnings: ["b"],
      },
    });

    proc.emit("close", 0);

    const result = await promise;
    expect(result.output).toEqual({
      success: true,
      summary: "done",
      key_changes_made: ["a"],
      key_learnings: ["b"],
    });
    expect(result.usage).toEqual({
      inputTokens: 150,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheCreationTokens: 10,
    });
  });

  it("calls onUsage on assistant events", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onUsage = vi.fn();

    const promise = agent.run("prompt", "/cwd", { onUsage });

    emitLine(proc, {
      type: "assistant",
      message: {
        usage: {
          input_tokens: 50,
          output_tokens: 100,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 5,
        },
      },
    });

    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 70,
      outputTokens: 100,
      cacheReadTokens: 20,
      cacheCreationTokens: 5,
    });

    emitLine(proc, {
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 50,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
        output_tokens: 100,
      },
      structured_output: {
        success: true,
        summary: "done",
        key_changes_made: [],
        key_learnings: [],
      },
    });

    proc.emit("close", 0);
    await promise;
  });

  it("does not double count repeated assistant events for the same message id", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onUsage = vi.fn();

    const promise = agent.run("prompt", "/cwd", { onUsage });

    emitLine(proc, {
      type: "assistant",
      message: {
        id: "msg-1",
        usage: {
          input_tokens: 6,
          output_tokens: 8,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 3,
        },
      },
    });

    emitLine(proc, {
      type: "assistant",
      message: {
        id: "msg-1",
        usage: {
          input_tokens: 6,
          output_tokens: 8,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 3,
        },
      },
    });

    emitLine(proc, {
      type: "assistant",
      message: {
        id: "msg-2",
        usage: {
          input_tokens: 1,
          output_tokens: 3,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 1,
        },
      },
    });

    emitLine(proc, {
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 7,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 4,
        output_tokens: 20,
      },
      structured_output: {
        success: true,
        summary: "done",
        key_changes_made: [],
        key_learnings: [],
      },
    });

    proc.emit("close", 0);
    await promise;

    expect(onUsage).toHaveBeenNthCalledWith(1, {
      inputTokens: 16,
      outputTokens: 8,
      cacheReadTokens: 10,
      cacheCreationTokens: 3,
    });
    expect(onUsage).toHaveBeenNthCalledWith(2, {
      inputTokens: 16,
      outputTokens: 8,
      cacheReadTokens: 10,
      cacheCreationTokens: 3,
    });
    expect(onUsage).toHaveBeenNthCalledWith(3, {
      inputTokens: 37,
      outputTokens: 11,
      cacheReadTokens: 30,
      cacheCreationTokens: 4,
    });
    expect(onUsage).toHaveBeenNthCalledWith(4, {
      inputTokens: 37,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 4,
    });
  });

  it("does not double count repeated assistant events without a message id", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onUsage = vi.fn();

    const promise = agent.run("prompt", "/cwd", { onUsage });

    emitLine(proc, {
      type: "assistant",
      message: {
        usage: {
          input_tokens: 6,
          output_tokens: 8,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 3,
        },
      },
    });

    emitLine(proc, {
      type: "assistant",
      message: {
        usage: {
          input_tokens: 6,
          output_tokens: 8,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 3,
        },
      },
    });

    emitLine(proc, {
      type: "assistant",
      message: {
        usage: {
          input_tokens: 1,
          output_tokens: 3,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 1,
        },
      },
    });

    emitLine(proc, {
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 7,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 4,
        output_tokens: 20,
      },
      structured_output: {
        success: true,
        summary: "done",
        key_changes_made: [],
        key_learnings: [],
      },
    });

    proc.emit("close", 0);
    await promise;

    expect(onUsage).toHaveBeenNthCalledWith(1, {
      inputTokens: 16,
      outputTokens: 8,
      cacheReadTokens: 10,
      cacheCreationTokens: 3,
    });
    expect(onUsage).toHaveBeenNthCalledWith(2, {
      inputTokens: 16,
      outputTokens: 8,
      cacheReadTokens: 10,
      cacheCreationTokens: 3,
    });
    expect(onUsage).toHaveBeenNthCalledWith(3, {
      inputTokens: 37,
      outputTokens: 11,
      cacheReadTokens: 30,
      cacheCreationTokens: 4,
    });
    expect(onUsage).toHaveBeenNthCalledWith(4, {
      inputTokens: 37,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 4,
    });
  });

  it("does not double count evolving assistant snapshots without a message id", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onUsage = vi.fn();

    const promise = agent.run("prompt", "/cwd", { onUsage });

    emitLine(proc, {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "hel" }],
        usage: {
          input_tokens: 6,
          output_tokens: 8,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 3,
        },
      },
    });

    emitLine(proc, {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "hello" }],
        usage: {
          input_tokens: 6,
          output_tokens: 10,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 3,
        },
      },
    });

    emitLine(proc, {
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 6,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 3,
        output_tokens: 10,
      },
      structured_output: {
        success: true,
        summary: "done",
        key_changes_made: [],
        key_learnings: [],
      },
    });

    proc.emit("close", 0);
    await promise;

    expect(onUsage).toHaveBeenNthCalledWith(1, {
      inputTokens: 16,
      outputTokens: 8,
      cacheReadTokens: 10,
      cacheCreationTokens: 3,
    });
    expect(onUsage).toHaveBeenNthCalledWith(2, {
      inputTokens: 16,
      outputTokens: 10,
      cacheReadTokens: 10,
      cacheCreationTokens: 3,
    });
    expect(onUsage).toHaveBeenNthCalledWith(3, {
      inputTokens: 16,
      outputTokens: 10,
      cacheReadTokens: 10,
      cacheCreationTokens: 3,
    });
  });

  it("recovers cumulative usage for distinct anonymous turns when payloads match", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onUsage = vi.fn();

    const promise = agent.run("prompt", "/cwd", { onUsage });

    emitLine(proc, {
      type: "assistant",
      message: {
        usage: {
          input_tokens: 6,
          output_tokens: 8,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 3,
        },
      },
    });

    emitLine(proc, {
      type: "assistant",
      message: {
        usage: {
          input_tokens: 6,
          output_tokens: 8,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 3,
        },
      },
    });

    emitLine(proc, {
      type: "assistant",
      message: {
        usage: {
          input_tokens: 12,
          output_tokens: 16,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 6,
        },
      },
    });

    emitLine(proc, {
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 18,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 9,
        output_tokens: 24,
      },
      structured_output: {
        success: true,
        summary: "done",
        key_changes_made: [],
        key_learnings: [],
      },
    });

    proc.emit("close", 0);
    await promise;

    expect(onUsage).toHaveBeenNthCalledWith(1, {
      inputTokens: 16,
      outputTokens: 8,
      cacheReadTokens: 10,
      cacheCreationTokens: 3,
    });
    expect(onUsage).toHaveBeenNthCalledWith(2, {
      inputTokens: 16,
      outputTokens: 8,
      cacheReadTokens: 10,
      cacheCreationTokens: 3,
    });
    expect(onUsage).toHaveBeenNthCalledWith(3, {
      inputTokens: 48,
      outputTokens: 24,
      cacheReadTokens: 30,
      cacheCreationTokens: 9,
    });
    expect(onUsage).toHaveBeenNthCalledWith(4, {
      inputTokens: 48,
      outputTokens: 24,
      cacheReadTokens: 30,
      cacheCreationTokens: 9,
    });
  });

  it("rejects when process exits with non-zero code", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");

    proc.stderr.emit("data", Buffer.from("something broke"));
    proc.emit("close", 1);

    await expect(promise).rejects.toThrow(
      "claude exited with code 1: something broke",
    );
  });

  it("rejects when process fails to spawn", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");

    proc.emit("error", new Error("ENOENT"));

    await expect(promise).rejects.toThrow("Failed to spawn claude: ENOENT");
  });

  it("rejects when no result event is received", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");

    emitLine(proc, { type: "system", subtype: "init" });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("claude returned no result event");
  });

  it("rejects when response has is_error flag", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");

    emitLine(proc, {
      type: "result",
      subtype: "error",
      is_error: true,
      usage: {
        input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
      },
      structured_output: null,
    });

    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("claude reported error");
  });

  it("rejects when structured_output is null", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");

    emitLine(proc, {
      type: "result",
      subtype: "success",
      is_error: false,
      usage: {
        input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
      },
      structured_output: null,
    });

    proc.emit("close", 0);

    await expect(promise).rejects.toThrow(
      "claude returned no structured_output",
    );
  });
});
