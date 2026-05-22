import { beforeEach, describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

import { execFileSync, spawn } from "node:child_process";
import { CursorAgent } from "./cursor.js";
import { PermanentAgentError, buildAgentOutputSchema } from "./types.js";

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

function emitJson(proc: ReturnType<typeof createMockProcess>, event: unknown) {
  proc.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
}

function finalOutput(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    success: true,
    summary: "ok",
    key_changes_made: [],
    key_learnings: [],
    ...extra,
  });
}

function assistantEvent(text: string): unknown {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
    session_id: "sess-1",
  };
}

describe("CursorAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has the cursor agent name", () => {
    expect(new CursorAgent().name).toBe("cursor");
  });

  it("spawns cursor-agent in non-interactive stream-json mode with default permission flags", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent({ platform: "darwin" });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(mockSpawn).toHaveBeenCalledWith("cursor-agent", args, {
      cwd: "/work/dir",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    expect(args[0]).toBe("-p");
    expect(args[1]).toContain("test prompt");
    expect(args[1]).toContain("gnhf final output contract");
    expect(args).toEqual(
      expect.arrayContaining([
        "--output-format",
        "stream-json",
        "--force",
        "--trust",
      ]),
    );
  });

  it("uses the configured schema in the prompt contract", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const schema = buildAgentOutputSchema({ includeStopField: true });
    const agent = new CursorAgent({ schema });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args[1]).toContain("should_fully_stop");
  });

  it("uses a custom binary path", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent({ bin: "/custom/cursor-agent" });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "/custom/cursor-agent",
      expect.any(Array),
      expect.any(Object),
    );
  });

  it("accepts a bare string as the binary path", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent("my-cursor-agent");

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "my-cursor-agent",
      expect.any(Array),
      expect.any(Object),
    );
  });

  it("does not use a shell for direct Windows launches", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent({ platform: "win32" });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "cursor-agent",
      expect.any(Array),
      expect.objectContaining({ shell: false }),
    );
  });

  it("uses a shell on Windows for cmd wrapper paths", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent({
      bin: "C:\\tools\\cursor-agent.cmd",
      platform: "win32",
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "C:\\tools\\cursor-agent.cmd",
      expect.any(Array),
      expect.objectContaining({ shell: true }),
    );
  });

  it("uses a shell on Windows when a bare override resolves to a cmd wrapper", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    vi.mocked(execFileSync).mockReturnValue(
      "C:\\tools\\cursor-agent-switch.cmd\r\n" as never,
    );
    const agent = new CursorAgent({
      bin: "cursor-agent-switch",
      platform: "win32",
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "cursor-agent-switch",
      expect.any(Array),
      expect.objectContaining({ shell: true }),
    );
  });

  it("passes configured extra args through and suppresses the default permission flags when overridden", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent({
      extraArgs: ["--model", "gpt-5", "--yolo"],
    });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args.slice(0, 3)).toEqual(["--model", "gpt-5", "--yolo"]);
    expect(args).not.toContain("--force");
    expect(args).not.toContain("--trust");
  });

  it("suppresses default permission flags when --sandbox is supplied", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent({
      extraArgs: ["--sandbox", "enabled"],
    });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args).not.toContain("--force");
    expect(args).not.toContain("--trust");
  });

  it("suppresses default permission flags when an explicit --trust is supplied", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent({
      extraArgs: ["--trust"],
    });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args).not.toContain("--force");
    expect(args.filter((arg) => arg === "--trust")).toHaveLength(1);
  });

  it("kills the full process tree on Windows when aborted", async () => {
    const proc = createMockProcess();
    Object.defineProperty(proc, "pid", { value: 9876 });
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
      ["/T", "/F", "/PID", "9876"],
      { stdio: "ignore" },
    );
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("uses SIGTERM on non-Windows platforms when aborted", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const controller = new AbortController();
    const agent = new CursorAgent({ platform: "darwin" });

    const promise = agent.run("test prompt", "/work/dir", {
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).rejects.toThrow("Agent was aborted");
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const controller = new AbortController();
    controller.abort();
    const agent = new CursorAgent({ platform: "darwin" });

    await expect(
      agent.run("test prompt", "/work/dir", { signal: controller.signal }),
    ).rejects.toThrow("Agent was aborted");
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("parses the final assistant message JSON and reports progress text", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onMessage = vi.fn();
    const onUsage = vi.fn();
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir", {
      onMessage,
      onUsage,
    });
    emitJson(proc, assistantEvent("Reading files..."));
    emitJson(proc, assistantEvent(finalOutput()));
    emitJson(proc, {
      type: "result",
      subtype: "success",
      is_error: false,
      result: `Reading files...${finalOutput()}`,
      session_id: "sess-1",
    });
    proc.emit("close", 0);

    const result = await promise;
    expect(result.output).toEqual({
      success: true,
      summary: "ok",
      key_changes_made: [],
      key_learnings: [],
    });
    // Without authoritative usage on the result event, the resolved usage is
    // the running estimate: prompt-token estimate as input + char-derived
    // estimate of all assistant text as output.
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.usage.cacheReadTokens).toBe(0);
    expect(result.usage.cacheCreationTokens).toBe(0);
    expect(result.usage.estimated).toBeUndefined();
    expect(onMessage).toHaveBeenCalledWith("Reading files...");
    expect(onMessage).toHaveBeenCalledWith(finalOutput());
    // Seed estimate, two assistant events, and the final result event all
    // trigger onUsage callbacks while the run is in flight. None should set
    // the estimated flag - cursor matches the display convention of the
    // other native agents (claude, codex, copilot, ...) and reports usage
    // without a "~" qualifier.
    expect(onUsage).toHaveBeenCalled();
    for (const call of onUsage.mock.calls) {
      expect(call[0].estimated).toBeUndefined();
    }
  });

  it("captures token usage from the terminal result event and forwards it via onUsage", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onUsage = vi.fn();
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir", { onUsage });
    emitJson(proc, assistantEvent(finalOutput()));
    emitJson(proc, {
      type: "result",
      subtype: "success",
      is_error: false,
      result: finalOutput(),
      session_id: "sess-1",
      usage: {
        inputTokens: 12,
        outputTokens: 34,
        cacheReadTokens: 567,
        cacheWriteTokens: 8,
      },
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toEqual({
      output: {
        success: true,
        summary: "ok",
        key_changes_made: [],
        key_learnings: [],
      },
      usage: {
        inputTokens: 12,
        outputTokens: 34,
        cacheReadTokens: 567,
        cacheCreationTokens: 8,
      },
    });
    // The terminal result event graduates the running estimate to the
    // authoritative numbers and the final onUsage call drops the estimated
    // flag - earlier calls during the run are still flagged as estimates.
    expect(onUsage).toHaveBeenLastCalledWith({
      inputTokens: 12,
      outputTokens: 34,
      cacheReadTokens: 567,
      cacheCreationTokens: 8,
    });
  });

  it("tolerates partial usage fields on the result event", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onUsage = vi.fn();
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir", { onUsage });
    emitJson(proc, assistantEvent(finalOutput()));
    emitJson(proc, {
      type: "result",
      subtype: "success",
      is_error: false,
      result: finalOutput(),
      session_id: "sess-1",
      usage: { inputTokens: 5, outputTokens: 9 },
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      usage: {
        inputTokens: 5,
        outputTokens: 9,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    });
    expect(onUsage).toHaveBeenLastCalledWith({
      inputTokens: 5,
      outputTokens: 9,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it("keeps live estimates when the result event carries an empty usage object", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onUsage = vi.fn();
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir", { onUsage });
    emitJson(proc, assistantEvent(finalOutput()));
    emitJson(proc, {
      type: "result",
      subtype: "success",
      is_error: false,
      result: finalOutput(),
      session_id: "sess-1",
      usage: {},
    });
    proc.emit("close", 0);

    const result = await promise;
    // Empty usage gives us no authoritative numbers, so the resolved usage
    // remains the running estimate.
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.estimated).toBeUndefined();
    expect(onUsage).toHaveBeenCalled();
    expect(onUsage.mock.calls.at(-1)?.[0].estimated).toBeUndefined();
  });

  it("falls back to live estimates on an errored result event", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onUsage = vi.fn();
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir", { onUsage });
    emitJson(proc, assistantEvent(finalOutput()));
    emitJson(proc, {
      type: "result",
      subtype: "error",
      is_error: true,
      session_id: "sess-1",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("cursor reported error");
    // We still seed and update estimates during the run; the errored result
    // does not get adopted as authoritative usage.
    expect(onUsage).toHaveBeenCalled();
    for (const call of onUsage.mock.calls) {
      expect(call[0].estimated).toBeUndefined();
    }
  });

  it("seeds an initial prompt-only usage estimate before any events arrive", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onUsage = vi.fn();
    const agent = new CursorAgent();

    agent.run("test prompt", "/work/dir", { onUsage });

    expect(onUsage).toHaveBeenCalledTimes(1);
    const first = onUsage.mock.calls[0]![0];
    expect(first.inputTokens).toBeGreaterThan(0);
    expect(first.outputTokens).toBe(0);
    expect(first.estimated).toBeUndefined();
  });

  it("grows the live input estimate when tool calls are reported", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onUsage = vi.fn();
    const agent = new CursorAgent();

    agent.run("test prompt", "/work/dir", { onUsage });
    const baseline = onUsage.mock.calls[0]![0].inputTokens as number;

    emitJson(proc, {
      type: "tool_call",
      subtype: "started",
      call_id: "call-1",
      session_id: "sess-1",
    });
    emitJson(proc, {
      type: "tool_call",
      subtype: "completed",
      call_id: "call-1",
      session_id: "sess-1",
    });

    const afterStart = onUsage.mock.calls.at(-1)![0];
    expect(afterStart.inputTokens).toBeGreaterThan(baseline);
    expect(afterStart.estimated).toBeUndefined();
    // `completed` events should not double-count toward the input estimate.
    expect(onUsage.mock.calls.length).toBe(2);
  });

  it("grows the live output estimate as thinking deltas stream in", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onUsage = vi.fn();
    const agent = new CursorAgent();

    agent.run("test prompt", "/work/dir", { onUsage });
    const baselineOutput = onUsage.mock.calls[0]![0].outputTokens as number;
    expect(baselineOutput).toBe(0);

    emitJson(proc, {
      type: "thinking",
      subtype: "delta",
      text: "Reasoning through the problem space step by step.",
      session_id: "sess-1",
    });
    emitJson(proc, {
      type: "thinking",
      subtype: "completed",
      session_id: "sess-1",
    });

    const afterDelta = onUsage.mock.calls.at(-1)![0];
    expect(afterDelta.outputTokens).toBeGreaterThan(0);
    expect(afterDelta.estimated).toBeUndefined();
    // `completed` thinking events without `text` should not trigger updates.
    expect(onUsage.mock.calls.length).toBe(2);
  });

  it("falls back to the terminal result event when no assistant messages were emitted", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "result",
      subtype: "success",
      is_error: false,
      result: finalOutput({ summary: "from result" }),
      session_id: "sess-1",
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { success: true, summary: "from result" },
    });
  });

  it("prefers the terminal result when assistant events stream JSON deltas", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();
    const output = finalOutput({ summary: "from result" });

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, assistantEvent(output.slice(0, 20)));
    emitJson(proc, assistantEvent(output.slice(20)));
    emitJson(proc, {
      type: "result",
      subtype: "success",
      is_error: false,
      result: output,
      session_id: "sess-1",
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { success: true, summary: "from result" },
    });
  });

  it("concatenates multi-block assistant content into the final message", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    proc.stdout.emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: '{"success":true,"summary":"' },
              {
                type: "text",
                text: 'ok","key_changes_made":[],"key_learnings":[]}',
              },
            ],
          },
        })}\n`,
      ),
    );
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { success: true, summary: "ok" },
    });
  });

  it("accepts a fenced JSON final answer", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(
      proc,
      assistantEvent(
        '```json\n{"success":true,"summary":"ok","key_changes_made":[],"key_learnings":[]}\n```',
      ),
    );
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { success: true, summary: "ok" },
    });
  });

  it("recovers JSON when cursor prepends prose before the final object", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(
      proc,
      assistantEvent(`Done.\n\n${finalOutput({ summary: "recovered" })}`),
    );
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { success: true, summary: "recovered" },
    });
  });

  it("ignores unparseable lines in the stream", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    proc.stdout.emit("data", Buffer.from("not json at all\n"));
    emitJson(proc, assistantEvent(finalOutput()));
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { success: true, summary: "ok" },
    });
  });

  it("includes should_fully_stop in the prompt contract when the schema requires it", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent({
      schema: buildAgentOutputSchema({ includeStopField: true }),
    });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args[1]).toContain("should_fully_stop");
  });

  it("rejects when cursor returns no assistant message and no terminal result", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("cursor returned no agent message");
  });

  it("rejects when the final assistant message is not valid JSON", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, assistantEvent("not json"));
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("Failed to parse cursor output");
  });

  it("rejects when the final assistant message misses required fields", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, assistantEvent('{"success":true,"summary":"ok"}'));
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("Failed to parse cursor output");
  });

  it("rejects commit fields that do not match the schema enum", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent({
      schema: buildAgentOutputSchema({
        includeStopField: false,
        commitFields: [{ name: "commit_type", allowed: ["feat", "fix"] }],
      }),
    });

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(
      proc,
      assistantEvent(
        JSON.stringify({
          success: true,
          summary: "ok",
          key_changes_made: [],
          key_learnings: [],
          commit_type: "chore",
        }),
      ),
    );
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("Failed to parse cursor output");
  });

  it("rejects when the terminal result event reports an error", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, assistantEvent(finalOutput()));
    emitJson(proc, {
      type: "result",
      subtype: "error",
      is_error: true,
      session_id: "sess-1",
    });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("cursor reported error");
  });

  it("rejects when the process exits with a non-zero code", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    proc.stderr.emit("data", Buffer.from("cursor-agent: not authenticated"));
    proc.emit("close", 1);

    await expect(promise).rejects.toThrow(
      "cursor exited with code 1: cursor-agent: not authenticated",
    );
    await expect(promise).rejects.not.toBeInstanceOf(PermanentAgentError);
  });

  it("marks invalid model name exits as permanent", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    proc.stderr.emit(
      "data",
      Buffer.from(
        "S: AI Model Not Found Model name is not valid: 'claude-opus-4-7'",
      ),
    );
    proc.emit("close", 1);

    await expect(promise).rejects.toBeInstanceOf(PermanentAgentError);
    await expect(promise).rejects.toMatchObject({
      message: "cursor: invalid model name - see gnhf.log",
      detail:
        "cursor exited with code 1: S: AI Model Not Found Model name is not valid: 'claude-opus-4-7'",
      cause:
        "cursor exited with code 1: S: AI Model Not Found Model name is not valid: 'claude-opus-4-7'",
    });
  });

  it("marks 'Cannot use this model' exits as permanent", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    proc.stderr.emit(
      "data",
      Buffer.from("Cannot use this model: gpt-5. Available models: auto, ..."),
    );
    proc.emit("close", 1);

    await expect(promise).rejects.toBeInstanceOf(PermanentAgentError);
    await expect(promise).rejects.toMatchObject({
      message: "cursor: invalid model name - see gnhf.log",
    });
  });

  it("treats network or auth failures as retryable", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    proc.stderr.emit(
      "data",
      Buffer.from("Failed to fetch: connection timed out"),
    );
    proc.emit("close", 1);

    await expect(promise).rejects.not.toBeInstanceOf(PermanentAgentError);
    await expect(promise).rejects.toThrow(
      "cursor exited with code 1: Failed to fetch: connection timed out",
    );
  });

  it("rejects when the process fails to spawn", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    proc.emit("error", new Error("ENOENT"));

    await expect(promise).rejects.toThrow("Failed to spawn cursor: ENOENT");
  });

  it("uses the last assistant message text when multiple are emitted", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CursorAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, assistantEvent("Thinking..."));
    emitJson(proc, assistantEvent("Almost done..."));
    emitJson(proc, assistantEvent(finalOutput({ summary: "final answer" })));
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { success: true, summary: "final answer" },
    });
  });
});
