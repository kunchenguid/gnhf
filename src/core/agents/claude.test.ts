import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { ClaudeAgent } from "./claude.js";

const mockSpawn = vi.mocked(spawn);

function createMockProcess() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: null,
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

  it("uses a shell on Windows so wrapper shims can launch", () => {
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
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );
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
