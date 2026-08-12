import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("../debug-log.js", () => ({
  appendDebugLog: vi.fn(),
  initDebugLog: vi.fn(),
  serializeError: vi.fn(),
}));

import { execFileSync, spawn } from "node:child_process";
import { appendDebugLog } from "../debug-log.js";
import { ClaudeAgent } from "./claude.js";
import { PermanentAgentError, buildAgentOutputSchema } from "./types.js";

const mockSpawn = vi.mocked(spawn);
const mockAppendDebugLog = vi.mocked(appendDebugLog);

const STOP_SCHEMA = buildAgentOutputSchema({
  includeStopField: true,
});

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
    const unixAgent = new ClaudeAgent({
      platform: "darwin",
    });

    unixAgent.run("test prompt", "/work/dir");

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
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );
  });

  it("uses the configured schema for --json-schema", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const configuredAgent = new ClaudeAgent({
      schema: STOP_SCHEMA,
    });

    configuredAgent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      [
        "-p",
        "test prompt",
        "--verbose",
        "--output-format",
        "stream-json",
        "--json-schema",
        JSON.stringify(STOP_SCHEMA),
        "--dangerously-skip-permissions",
      ],
      expect.any(Object),
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
        detached: false,
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
        detached: false,
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
        detached: false,
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

  it("terminates the process group after a final structured output if Claude stays alive", async () => {
    vi.useFakeTimers();
    const processKill = vi
      .spyOn(process, "kill")
      .mockImplementation(() => true);
    try {
      const proc = createMockProcess();
      Object.defineProperty(proc, "pid", { value: 4321 });
      mockSpawn.mockReturnValue(proc);
      const configuredAgent = new ClaudeAgent({
        finalResultGraceMs: 25,
        platform: "darwin",
      });

      const promise = configuredAgent.run("prompt", "/cwd");

      emitLine(proc, {
        type: "result",
        subtype: "success",
        is_error: false,
        usage: {
          input_tokens: 7,
          cache_read_input_tokens: 8,
          cache_creation_input_tokens: 9,
          output_tokens: 10,
        },
        structured_output: {
          success: true,
          summary: "done",
          key_changes_made: [],
          key_learnings: [],
        },
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

  it("force kills Claude if it ignores the final-result shutdown signal", async () => {
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
    const configuredAgent = new ClaudeAgent({
      finalResultGraceMs: 25,
      platform: "darwin",
    });

    try {
      const promise = configuredAgent.run("prompt", "/cwd");

      emitLine(proc, {
        type: "result",
        subtype: "success",
        is_error: false,
        usage: {
          input_tokens: 7,
          cache_read_input_tokens: 8,
          cache_creation_input_tokens: 9,
          output_tokens: 10,
        },
        structured_output: {
          success: true,
          summary: "done",
          key_changes_made: [],
          key_learnings: [],
        },
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

  it("restarts the final-result cleanup timer when a later turn returns structured output", async () => {
    vi.useFakeTimers();
    const processKill = vi
      .spyOn(process, "kill")
      .mockImplementation(() => true);
    try {
      const proc = createMockProcess();
      Object.defineProperty(proc, "pid", { value: 4321 });
      mockSpawn.mockReturnValue(proc);
      const configuredAgent = new ClaudeAgent({
        finalResultGraceMs: 25,
        platform: "darwin",
      });

      const promise = configuredAgent.run("prompt", "/cwd");

      emitLine(proc, {
        type: "result",
        subtype: "success",
        is_error: false,
        usage: {
          input_tokens: 7,
          cache_read_input_tokens: 8,
          cache_creation_input_tokens: 9,
          output_tokens: 10,
        },
        structured_output: {
          success: true,
          summary: "first turn",
          key_changes_made: [],
          key_learnings: [],
        },
      });

      await vi.advanceTimersByTimeAsync(20);

      emitLine(proc, {
        type: "result",
        subtype: "success",
        is_error: false,
        usage: {
          input_tokens: 11,
          cache_read_input_tokens: 12,
          cache_creation_input_tokens: 13,
          output_tokens: 14,
        },
        structured_output: {
          success: true,
          summary: "second turn",
          key_changes_made: [],
          key_learnings: [],
        },
      });

      await vi.advanceTimersByTimeAsync(4);
      expect(processKill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(processKill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(19);
      expect(processKill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(processKill).toHaveBeenCalledWith(-4321, "SIGTERM");

      proc.emit("close", null);
      await expect(promise).resolves.toMatchObject({
        output: { success: true, summary: "second turn" },
      });
    } finally {
      processKill.mockRestore();
      vi.useRealTimers();
    }
  });

  it("waits 15 seconds by default before terminating after final structured output", async () => {
    vi.useFakeTimers();
    const processKill = vi
      .spyOn(process, "kill")
      .mockImplementation(() => true);
    try {
      const proc = createMockProcess();
      Object.defineProperty(proc, "pid", { value: 4321 });
      mockSpawn.mockReturnValue(proc);
      const unixAgent = new ClaudeAgent({
        platform: "darwin",
      });

      const promise = unixAgent.run("prompt", "/cwd");

      emitLine(proc, {
        type: "result",
        subtype: "success",
        is_error: false,
        usage: {
          input_tokens: 7,
          cache_read_input_tokens: 8,
          cache_creation_input_tokens: 9,
          output_tokens: 10,
        },
        structured_output: {
          success: true,
          summary: "done",
          key_changes_made: [],
          key_learnings: [],
        },
      });

      await vi.advanceTimersByTimeAsync(14_999);
      expect(processKill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(processKill).toHaveBeenCalledWith(-4321, "SIGTERM");

      proc.emit("close", null);
      await promise;
    } finally {
      processKill.mockRestore();
      vi.useRealTimers();
    }
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

  it("surfaces a structured stdout error when stderr is empty", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");

    emitLine(proc, {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "Invalid model name: claude-nonexistent-5",
    });
    proc.emit("close", 1);

    await expect(promise).rejects.toThrow(
      "claude exited with code 1: Invalid model name: claude-nonexistent-5",
    );
  });

  it("surfaces plain-text stdout output when stderr is empty", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");

    proc.stdout.emit(
      "data",
      Buffer.from("Invalid API key - please run /login"),
    );
    proc.emit("close", 1);

    await expect(promise).rejects.toThrow(
      "claude exited with code 1: Invalid API key - please run /login",
    );
  });

  it("reports both streams when stderr and stdout carry output", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");

    proc.stderr.emit("data", Buffer.from("something broke"));
    emitLine(proc, {
      type: "error",
      error: { message: "rate limit exceeded" },
    });
    proc.emit("close", 1);

    await expect(promise).rejects.toThrow(
      "claude exited with code 1: something broke\nrate limit exceeded",
    );
  });

  it("bounds the stdout tail included in the failure detail", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");

    proc.stdout.emit("data", Buffer.from("x".repeat(10_000) + "tail marker"));
    proc.emit("close", 1);

    const message = await promise.then(
      () => "",
      (err: Error) => err.message,
    );
    expect(message).toContain("tail marker");
    expect(message).toContain("[...truncated");
    expect(message.length).toBeLessThan(600);
  });

  it("says so when a non-zero exit produced no output at all", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");

    proc.emit("close", 1);

    await expect(promise).rejects.toThrow(
      "claude exited with code 1 and produced no output",
    );
  });

  it("marks a low credit balance reported on stdout as permanent", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");

    emitLine(proc, {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "Credit balance is too low to access Claude Code",
    });
    proc.emit("close", 1);

    await expect(promise).rejects.toBeInstanceOf(PermanentAgentError);
    await expect(promise).rejects.toMatchObject({
      detail:
        "claude exited with code 1: Credit balance is too low to access Claude Code",
    });
  });

  it("keeps a run retryable when only agent output quotes a permanent failure", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");

    emitLine(proc, {
      type: "assistant",
      message: {
        id: "msg-1",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          {
            type: "text",
            text: "The docs say 'credit balance is too low' aborts the run.",
          },
        ],
      },
    });
    proc.emit("close", 1);

    await expect(promise).rejects.not.toBeInstanceOf(PermanentAgentError);
    await expect(promise).rejects.toThrow("claude exited with code 1:");
  });

  it("keeps a run retryable when unparseable stdout quotes a permanent failure", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");

    proc.stdout.emit(
      "data",
      Buffer.from("grep: README.md: credit balance is too low"),
    );
    proc.emit("close", 1);

    await expect(promise).rejects.not.toBeInstanceOf(PermanentAgentError);
    await expect(promise).rejects.toThrow(
      "claude exited with code 1: grep: README.md: credit balance is too low",
    );
  });

  it("marks low credit balance exits as permanent", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");

    proc.stderr.emit(
      "data",
      Buffer.from("Credit balance is too low to access Claude Code"),
    );
    proc.emit("close", 1);

    await expect(promise).rejects.toBeInstanceOf(PermanentAgentError);
    await expect(promise).rejects.toMatchObject({
      message: "claude credit balance too low - see gnhf.log",
      detail:
        "claude exited with code 1: Credit balance is too low to access Claude Code",
      cause:
        "claude exited with code 1: Credit balance is too low to access Claude Code",
    });
  });

  it("treats other credit balance failures as retryable", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");

    proc.stderr.emit(
      "data",
      Buffer.from("Failed to fetch credit balance: temporary network failure"),
    );
    proc.emit("close", 1);

    await expect(promise).rejects.not.toBeInstanceOf(PermanentAgentError);
    await expect(promise).rejects.toThrow(
      "claude exited with code 1: Failed to fetch credit balance: temporary network failure",
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

  it("resumes the same session once with the bare nudge when structured_output is null", async () => {
    const first = createMockProcess();
    const second = createMockProcess();
    mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const promise = agent.run("prompt", "/cwd");

    emitLine(first, {
      type: "system",
      subtype: "init",
      session_id: "session-abc",
    });
    emitLine(first, {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "session-abc",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 5,
      },
      structured_output: null,
    });
    first.emit("close", 0);

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));

    emitLine(second, {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "session-abc",
      usage: {
        input_tokens: 3,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 2,
      },
      structured_output: {
        success: true,
        summary: "recovered",
        key_changes_made: [],
        key_learnings: [],
      },
    });
    second.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { success: true, summary: "recovered" },
      usage: { inputTokens: 13, outputTokens: 7 },
    });

    const continuationArgs = mockSpawn.mock.calls[1]![1] as string[];
    expect(continuationArgs).toContain("--resume");
    expect(continuationArgs[continuationArgs.indexOf("--resume") + 1]).toBe(
      "session-abc",
    );
    expect(continuationArgs[continuationArgs.indexOf("-p") + 1]).toBe(
      "You did not produce a final answer. Continue and provide your final summary now.",
    );
    expect(continuationArgs).toContain("--json-schema");
    expect(mockAppendDebugLog).toHaveBeenCalledWith(
      "claude:output:continuation",
      expect.objectContaining({ attempt: 1 }),
    );
  });

  it.each(["-c", "--continue"])(
    "replaces configured %s with the captured session id for recovery",
    async (continuationArg) => {
      const first = createMockProcess();
      const second = createMockProcess();
      mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
      const continuingAgent = new ClaudeAgent({
        extraArgs: [continuationArg],
      });

      const promise = continuingAgent.run("prompt", "/cwd");

      emitLine(first, {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "session-continued",
        usage: {
          input_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 1,
        },
        structured_output: null,
      });
      first.emit("close", 0);

      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));

      const initialArgs = mockSpawn.mock.calls[0]![1] as string[];
      const continuationArgs = mockSpawn.mock.calls[1]![1] as string[];
      expect(initialArgs).toContain(continuationArg);
      expect(continuationArgs).not.toContain(continuationArg);
      expect(continuationArgs).toContain("--resume");
      expect(continuationArgs[continuationArgs.indexOf("--resume") + 1]).toBe(
        "session-continued",
      );

      emitLine(second, {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "session-continued",
        usage: {
          input_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 1,
        },
        structured_output: {
          success: true,
          summary: "recovered",
          key_changes_made: [],
          key_learnings: [],
        },
      });
      second.emit("close", 0);

      await expect(promise).resolves.toMatchObject({
        output: { summary: "recovered" },
      });
    },
  );

  it("rejects after exactly one continuation when structured_output is still null", async () => {
    const first = createMockProcess();
    const second = createMockProcess();
    mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const promise = agent.run("prompt", "/cwd");

    const emptyResult = {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "session-abc",
      usage: {
        input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
      },
      structured_output: null,
    };

    emitLine(first, emptyResult);
    first.emit("close", 0);

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
    emitLine(second, emptyResult);
    second.emit("close", 0);

    await expect(promise).rejects.toThrow(
      "claude returned no structured_output",
    );
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("does not continue when --no-session-persistence makes the session unresumable", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const noPersistenceAgent = new ClaudeAgent({
      extraArgs: ["--no-session-persistence"],
    });

    const promise = noPersistenceAgent.run("prompt", "/cwd");

    emitLine(proc, {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "session-abc",
      usage: {
        input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
      },
      structured_output: null,
    });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow(/--no-session-persistence/);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockAppendDebugLog).not.toHaveBeenCalledWith(
      "claude:output:continuation",
      expect.anything(),
    );
  });

  it("does not continue when claude reported no session id", async () => {
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

    await expect(promise).rejects.toThrow(/no session id/);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it.each(["-c", "--continue"])(
    "does not recover configured %s without a captured session id",
    async (continuationArg) => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);
      const continuingAgent = new ClaudeAgent({
        extraArgs: [continuationArg],
      });

      const promise = continuingAgent.run("prompt", "/cwd");

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

      await expect(promise).rejects.toThrow(/no session id/);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockAppendDebugLog).not.toHaveBeenCalledWith(
        "claude:output:continuation",
        expect.anything(),
      );
    },
  );

  it("does not continue when claude reported an error result", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");

    emitLine(proc, {
      type: "result",
      subtype: "error_during_execution",
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
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("picks up structured_output from a later result event when the first had none", async () => {
    // If the agent schedules a wakeup before calling StructuredOutput, the
    // first result event has structured_output: null. A later turn produces
    // the real answer, and that one should be used.
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");

    emitLine(proc, {
      type: "result",
      subtype: "success",
      is_error: false,
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
        output_tokens: 30,
      },
      structured_output: null,
    });

    emitLine(proc, {
      type: "result",
      subtype: "success",
      is_error: false,
      usage: {
        input_tokens: 11,
        cache_read_input_tokens: 25,
        cache_creation_input_tokens: 5,
        output_tokens: 50,
      },
      structured_output: {
        success: true,
        summary: "later turn submitted",
        key_changes_made: [],
        key_learnings: ["noticed after a wakeup"],
      },
    });

    proc.emit("close", 0);

    const result = await promise;
    expect(result.output).toEqual({
      success: true,
      summary: "later turn submitted",
      key_changes_made: [],
      key_learnings: ["noticed after a wakeup"],
    });
  });

  it("keeps an earlier structured_output when later result events arrive with null output", async () => {
    // ScheduleWakeup / Stop-hook continuations can produce additional
    // result events after the iteration has already submitted its
    // structured output. Those follow-up result events have
    // structured_output: null and must not clobber the real one.
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");

    emitLine(proc, {
      type: "result",
      subtype: "success",
      is_error: false,
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
        output_tokens: 40,
      },
      structured_output: {
        success: true,
        summary: "first real result",
        key_changes_made: ["file.ts"],
        key_learnings: [],
      },
    });

    emitLine(proc, {
      type: "result",
      subtype: "success",
      is_error: false,
      usage: {
        input_tokens: 11,
        cache_read_input_tokens: 21,
        cache_creation_input_tokens: 5,
        output_tokens: 42,
      },
      structured_output: null,
    });

    proc.emit("close", 0);

    const result = await promise;
    expect(result.output).toEqual({
      success: true,
      summary: "first real result",
      key_changes_made: ["file.ts"],
      key_learnings: [],
    });
  });

  it("keeps latest usage when later success result omits structured output", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");

    emitLine(proc, {
      type: "result",
      subtype: "success",
      is_error: false,
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
        output_tokens: 40,
      },
      structured_output: {
        success: true,
        summary: "first real result",
        key_changes_made: ["file.ts"],
        key_learnings: [],
      },
    });

    emitLine(proc, {
      type: "result",
      subtype: "success",
      is_error: false,
      usage: {
        input_tokens: 13,
        cache_read_input_tokens: 24,
        cache_creation_input_tokens: 6,
        output_tokens: 47,
      },
      structured_output: null,
    });

    proc.emit("close", 0);

    const result = await promise;
    expect(result.output).toEqual({
      success: true,
      summary: "first real result",
      key_changes_made: ["file.ts"],
      key_learnings: [],
    });
    expect(result.usage).toEqual({
      inputTokens: 37,
      outputTokens: 47,
      cacheReadTokens: 24,
      cacheCreationTokens: 6,
    });
  });

  it("keeps the last structured success when a later error result arrives", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");

    emitLine(proc, {
      type: "result",
      subtype: "success",
      is_error: false,
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
        output_tokens: 40,
      },
      structured_output: {
        success: true,
        summary: "first real result",
        key_changes_made: ["file.ts"],
        key_learnings: [],
      },
    });

    emitLine(proc, {
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      usage: {
        input_tokens: 11,
        cache_read_input_tokens: 21,
        cache_creation_input_tokens: 5,
        output_tokens: 42,
      },
      structured_output: null,
    });

    proc.emit("close", 0);

    const result = await promise;
    expect(result.output).toEqual({
      success: true,
      summary: "first real result",
      key_changes_made: ["file.ts"],
      key_learnings: [],
    });
    expect(result.usage).toEqual({
      inputTokens: 32,
      outputTokens: 42,
      cacheReadTokens: 21,
      cacheCreationTokens: 5,
    });
  });
});
