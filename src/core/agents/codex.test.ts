import { beforeEach, describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

import { execFileSync, spawn } from "node:child_process";
import { CodexAgent } from "./codex.js";

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

describe("CodexAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not use a shell for direct Windows launches", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CodexAgent("/tmp/schema.json", {
      platform: "win32",
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "codex",
      [
        "exec",
        "test prompt",
        "--json",
        "--output-schema",
        "/tmp/schema.json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--color",
        "never",
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
    const agent = new CodexAgent("/tmp/schema.json", {
      bin: "C:\\tools\\codex.cmd",
      platform: "win32",
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "C:\\tools\\codex.cmd",
      [
        "exec",
        "test prompt",
        "--json",
        "--output-schema",
        "/tmp/schema.json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--color",
        "never",
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
      "C:\\tools\\codex-switch.cmd\r\n" as never,
    );
    const agent = new CodexAgent("/tmp/schema.json", {
      bin: "codex-switch",
      platform: "win32",
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "codex-switch",
      [
        "exec",
        "test prompt",
        "--json",
        "--output-schema",
        "/tmp/schema.json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--color",
        "never",
      ],
      {
        cwd: "/work/dir",
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );
  });

  it("passes configured extra args through to codex exec", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CodexAgent("/tmp/schema.json", {
      extraArgs: [
        "-m",
        "gpt-5.4",
        "-c",
        'model_reasoning_effort="high"',
        "--full-auto",
      ],
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "codex",
      [
        "exec",
        "-m",
        "gpt-5.4",
        "-c",
        'model_reasoning_effort="high"',
        "--full-auto",
        "test prompt",
        "--json",
        "--output-schema",
        "/tmp/schema.json",
        "--color",
        "never",
      ],
      expect.any(Object),
    );
  });

  it("adds the configured model after extra args", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CodexAgent("/tmp/schema.json", {
      model: "gpt-5.4",
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "codex",
      [
        "exec",
        "--model",
        "gpt-5.4",
        "test prompt",
        "--json",
        "--output-schema",
        "/tmp/schema.json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--color",
        "never",
      ],
      expect.any(Object),
    );
  });

  it("suppresses the default dangerous flag when the user sets sandbox mode with = syntax", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CodexAgent("/tmp/schema.json", {
      extraArgs: ["--sandbox=workspace-write"],
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "codex",
      [
        "exec",
        "--sandbox=workspace-write",
        "test prompt",
        "--json",
        "--output-schema",
        "/tmp/schema.json",
        "--color",
        "never",
      ],
      expect.any(Object),
    );
  });

  it("kills the full process tree on Windows when aborted", async () => {
    const proc = createMockProcess();
    Object.defineProperty(proc, "pid", { value: 6789 });
    mockSpawn.mockReturnValue(proc);
    const controller = new AbortController();
    const agent = new CodexAgent("/tmp/schema.json", {
      platform: "win32",
    });

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

  it("surfaces a structured error emitted on stdout after a non-zero exit", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CodexAgent("/tmp/schema.json");

    const promise = agent.run("test prompt", "/work/dir");
    proc.stdout.emit(
      "data",
      Buffer.from('{"type":"error","error":{"message":"login required"}}\n'),
    );
    proc.emit("close", 1);

    await expect(promise).rejects.toThrow(
      "codex exited with code 1: login required",
    );
  });

  it("reports cached input tokens without double-counting them", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onUsage = vi.fn();
    const agent = new CodexAgent("/tmp/schema.json");

    const promise = agent.run("test prompt", "/work/dir", { onUsage });
    proc.stdout.emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 1500,
            cached_input_tokens: 1024,
            output_tokens: 500,
          },
        })}\n`,
      ),
    );
    proc.stdout.emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text: JSON.stringify({
              success: true,
              summary: "ok",
              key_changes_made: [],
              key_learnings: [],
            }),
          },
        })}\n`,
      ),
    );
    proc.emit("close", 0);

    await expect(promise).resolves.toEqual({
      output: {
        success: true,
        summary: "ok",
        key_changes_made: [],
        key_learnings: [],
      },
      usage: {
        inputTokens: 476,
        outputTokens: 500,
        cacheReadTokens: 1024,
        cacheCreationTokens: 0,
      },
    });
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 476,
      outputTokens: 500,
      cacheReadTokens: 1024,
      cacheCreationTokens: 0,
    });
  });
});
