import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

import { execFileSync, spawn } from "node:child_process";
import { GrokAgent } from "./grok.js";
import { buildAgentOutputSchema } from "./types.js";

const mockSpawn = vi.mocked(spawn);

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

describe("GrokAgent", () => {
  let agent: GrokAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new GrokAgent();
  });

  it("has name 'grok'", () => {
    expect(agent.name).toBe("grok");
  });

  it("spawns grok with streaming-json output format and always-approve", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const unixAgent = new GrokAgent({
      platform: "darwin",
    });

    unixAgent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "grok",
      [
        "-p",
        "test prompt",
        "--output-format",
        "streaming-json",
        "--json-schema",
        expect.any(String),
        "--always-approve",
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
    const configuredAgent = new GrokAgent({
      schema: STOP_SCHEMA,
    });

    configuredAgent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "grok",
      [
        "-p",
        "test prompt",
        "--output-format",
        "streaming-json",
        "--json-schema",
        JSON.stringify(STOP_SCHEMA),
        "--always-approve",
      ],
      expect.any(Object),
    );
  });

  it("does not use a shell for direct Windows launches", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const windowsAgent = new GrokAgent({
      platform: "win32",
    });

    windowsAgent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "grok",
      [
        "-p",
        "test prompt",
        "--output-format",
        "streaming-json",
        "--json-schema",
        expect.any(String),
        "--always-approve",
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
    const windowsAgent = new GrokAgent({
      bin: "C:\\tools\\grok.cmd",
      platform: "win32",
    });

    windowsAgent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "C:\\tools\\grok.cmd",
      [
        "-p",
        "test prompt",
        "--output-format",
        "streaming-json",
        "--json-schema",
        expect.any(String),
        "--always-approve",
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
      "C:\\tools\\grok-wrapper.cmd\r\n" as never,
    );
    const windowsAgent = new GrokAgent({
      bin: "grok-wrapper",
      platform: "win32",
    });

    windowsAgent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "grok-wrapper",
      [
        "-p",
        "test prompt",
        "--output-format",
        "streaming-json",
        "--json-schema",
        expect.any(String),
        "--always-approve",
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

  it("passes configured extra args through to grok", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const configuredAgent = new GrokAgent({
      extraArgs: ["-m", "grok-4.5-build", "--permission-mode", "auto"],
    });

    configuredAgent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "grok",
      [
        "-m",
        "grok-4.5-build",
        "--permission-mode",
        "auto",
        "-p",
        "test prompt",
        "--output-format",
        "streaming-json",
        "--json-schema",
        expect.any(String),
      ],
      expect.any(Object),
    );
  });

  it("does not add --always-approve when the user already set --always-approve", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const configuredAgent = new GrokAgent({
      extraArgs: ["--always-approve"],
    });

    configuredAgent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "grok",
      [
        "--always-approve",
        "-p",
        "test prompt",
        "--output-format",
        "streaming-json",
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
    const windowsAgent = new GrokAgent({
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

  it("resolves structuredOutput and usage from the end event", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onMessage = vi.fn();
    const onUsage = vi.fn();

    const promise = agent.run("prompt", "/cwd", { onMessage, onUsage });

    emitLine(proc, { type: "text", data: '{"success":' });
    emitLine(proc, { type: "text", data: "true}" });
    emitLine(proc, {
      type: "end",
      stopReason: "EndTurn",
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 50,
        output_tokens: 20,
        reasoning_tokens: 5,
        total_tokens: 175,
      },
      structuredOutput: {
        success: true,
        summary: "done",
        key_changes_made: ["a"],
        key_learnings: ["b"],
      },
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toEqual({
      output: {
        success: true,
        summary: "done",
        key_changes_made: ["a"],
        key_learnings: ["b"],
      },
      usage: {
        inputTokens: 150,
        outputTokens: 20,
        cacheReadTokens: 50,
        cacheCreationTokens: 0,
      },
    });
    expect(onMessage).toHaveBeenCalledWith('{"success":true}');
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 150,
      outputTokens: 20,
      cacheReadTokens: 50,
      cacheCreationTokens: 0,
    });
  });

  it("falls back to parsing streamed text when structuredOutput is missing", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");

    emitLine(proc, {
      type: "text",
      data: JSON.stringify({
        success: true,
        summary: "from text",
        key_changes_made: [],
        key_learnings: [],
      }),
    });
    emitLine(proc, {
      type: "end",
      stopReason: "EndTurn",
      usage: {
        input_tokens: 10,
        output_tokens: 4,
      },
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { success: true, summary: "from text" },
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    });
  });

  it("rejects when grok exits non-zero", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");
    proc.stderr.emit("data", Buffer.from("auth failed"));
    proc.emit("close", 1);

    await expect(promise).rejects.toThrow(
      "grok exited with code 1: auth failed",
    );
  });

  it("rejects when there is no end event", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("grok returned no end event");
  });

  it("rejects unexpected stopReason values", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");
    emitLine(proc, {
      type: "end",
      stopReason: "Error",
      structuredOutput: {
        success: true,
        summary: "x",
        key_changes_made: [],
        key_learnings: [],
      },
    });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow('grok reported stopReason "Error"');
  });

  it("rejects invalid structuredOutput against the schema", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");
    emitLine(proc, {
      type: "end",
      stopReason: "EndTurn",
      structuredOutput: { success: true },
    });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("Invalid grok output");
  });
});
