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

  it("kills the whole process group on unix when aborted", async () => {
    const proc = createMockProcess();
    Object.defineProperty(proc, "pid", { value: 4321 });
    mockSpawn.mockReturnValue(proc);
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(() => true as never);
    const controller = new AbortController();
    const unixAgent = new GrokAgent({ platform: "darwin" });

    const promise = unixAgent.run("test prompt", "/work/dir", {
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).rejects.toThrow("Agent was aborted");
    expect(killSpy).toHaveBeenCalledWith(-4321, "SIGTERM");
    expect(proc.kill).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it("falls back to signalling the child directly when it leads no group", async () => {
    const proc = createMockProcess();
    Object.defineProperty(proc, "pid", { value: 4321 });
    mockSpawn.mockReturnValue(proc);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    const controller = new AbortController();
    const unixAgent = new GrokAgent({ platform: "darwin" });

    const promise = unixAgent.run("test prompt", "/work/dir", {
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).rejects.toThrow("Agent was aborted");
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    killSpy.mockRestore();
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
        outputTokens: 25,
        cacheReadTokens: 50,
        cacheCreationTokens: 0,
      },
    });
    expect(onMessage).toHaveBeenCalledWith('{"success":true}');
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 150,
      outputTokens: 25,
      cacheReadTokens: 50,
      cacheCreationTokens: 0,
    });
  });

  it("accounts for reasoning tokens reported outside output_tokens", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");

    emitLine(proc, {
      type: "end",
      stopReason: "EndTurn",
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        reasoning_tokens: 4000,
        total_tokens: 5200,
      },
      structuredOutput: {
        success: true,
        summary: "done",
        key_changes_made: [],
        key_learnings: [],
      },
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      usage: {
        inputTokens: 1000,
        outputTokens: 4200,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    });
  });

  it("reports usage only after the finished iteration has settled", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const controller = new AbortController();
    // Mirrors the orchestrator aborting mid-iteration once --max-tokens trips.
    const onUsage = vi.fn(() => controller.abort());

    const promise = agent.run("prompt", "/cwd", {
      onUsage,
      signal: controller.signal,
    });

    emitLine(proc, {
      type: "end",
      stopReason: "EndTurn",
      usage: { input_tokens: 100, output_tokens: 100 },
      structuredOutput: {
        success: true,
        summary: "done",
        key_changes_made: [],
        key_learnings: [],
      },
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { success: true, summary: "done" },
    });
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it("keeps surfacing the most recent streamed text", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onMessage = vi.fn();

    const promise = agent.run("prompt", "/cwd", { onMessage });

    emitLine(proc, { type: "text", data: "a".repeat(2000) });
    emitLine(proc, { type: "text", data: " newest output" });
    emitLine(proc, {
      type: "end",
      stopReason: "EndTurn",
      structuredOutput: {
        success: true,
        summary: "done",
        key_changes_made: [],
        key_learnings: [],
      },
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { success: true },
    });
    const lastMessage = onMessage.mock.calls.at(-1)?.[0] as string;
    expect(lastMessage.endsWith("newest output")).toBe(true);
    expect(lastMessage.length).toBeLessThanOrEqual(200);
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

  it("accepts unrecognised terminal stopReason values", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");
    emitLine(proc, {
      type: "end",
      stopReason: "Completed",
      structuredOutput: {
        success: true,
        summary: "x",
        key_changes_made: [],
        key_learnings: [],
      },
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { success: true, summary: "x" },
    });
  });

  it("prefers the streamed JSON object that matches the schema", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");
    emitLine(proc, {
      type: "text",
      data: `Here is the result:\n${JSON.stringify({
        success: true,
        summary: "from text",
        key_changes_made: [],
        key_learnings: [],
      })}\nDebug: {"tool":"bash"}`,
    });
    emitLine(proc, { type: "end", stopReason: "EndTurn" });
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { success: true, summary: "from text" },
    });
  });

  it("reports unparseable streamed text as a parse failure", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = agent.run("prompt", "/cwd");
    emitLine(proc, { type: "text", data: "I could not finish the task." });
    emitLine(proc, { type: "end", stopReason: "EndTurn" });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow(
      "grok output did not contain a parseable JSON object",
    );
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
