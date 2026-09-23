import { beforeEach, describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { GrokAgent } from "./grok.js";
import {
  buildAgentOutputSchema,
  PermanentAgentError,
  RateLimitAgentError,
} from "./types.js";

const mockSpawn = vi.mocked(spawn);
const schema = buildAgentOutputSchema({ includeStopField: false });

function createMockProcess() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  return proc as typeof proc & ReturnType<typeof spawn>;
}

function emitJson(proc: ReturnType<typeof createMockProcess>, event: unknown) {
  proc.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
}

const output = {
  success: true,
  summary: "done",
  key_changes_made: ["b.txt"],
  key_learnings: ["a.txt said hi"],
};

function endEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "end",
    stopReason: "end_turn",
    sessionId: "01a0cbfc-44c3-7a51-8b07-6e9cc6e90ca6",
    usage: {
      input_tokens: 19298,
      cache_read_input_tokens: 19200,
      cache_creation_input_tokens: 0,
      output_tokens: 442,
      reasoning_tokens: 289,
      total_tokens: 38940,
    },
    num_turns: 2,
    total_cost_usd: 0.01598272,
    structuredOutput: output,
    ...overrides,
  };
}

describe("GrokAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spawns grok headless with streaming-json, the output schema, and always-approve", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    new GrokAgent({ platform: "linux", schema }).run(
      "test prompt",
      "/work/dir",
    );

    expect(mockSpawn).toHaveBeenCalledWith(
      "grok",
      [
        "-p",
        "test prompt",
        "--output-format",
        "streaming-json",
        "--json-schema",
        JSON.stringify(schema),
        "--always-approve",
        "--trust",
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

  it("replaces user model args with the configured model and respects user permission and trust flags", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    new GrokAgent({
      extraArgs: [
        "-m",
        "old-model",
        "--model=older",
        "--effort",
        "high",
        "--yolo",
        "--trust",
      ],
      model: "grok-4.5-build",
      platform: "linux",
      schema,
    }).run("test prompt", "/work/dir");

    expect(mockSpawn.mock.calls[0]![1]).toEqual([
      "--effort",
      "high",
      "--yolo",
      "--trust",
      "-m",
      "grok-4.5-build",
      "-p",
      "test prompt",
      "--output-format",
      "streaming-json",
      "--json-schema",
      JSON.stringify(schema),
    ]);
  });

  it("returns the end event's structured output and usage, streaming per-request usage and text", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onUsage = vi.fn();
    const onMessage = vi.fn();

    const promise = new GrokAgent({ schema }).run("test prompt", "/work/dir", {
      onUsage,
      onMessage,
    });
    emitJson(proc, { type: "thought", data: "The user wants" });
    emitJson(proc, { type: "text", data: "Reading" });
    emitJson(proc, { type: "text", data: " a.txt" });
    emitJson(proc, {
      type: "usage",
      usage: {
        input_tokens: 19007,
        output_tokens: 161,
        cache_read_input_tokens: 128,
        cache_creation_input_tokens: 0,
        reasoning_tokens: 58,
      },
    });
    emitJson(proc, {
      type: "tool_call",
      toolCallId: "call-1",
      toolName: "run_terminal_command",
      status: "pending",
    });
    emitJson(proc, {
      type: "usage",
      usage: {
        input_tokens: 291,
        output_tokens: 281,
        cache_read_input_tokens: 19072,
        cache_creation_input_tokens: 0,
        reasoning_tokens: 231,
      },
    });
    emitJson(proc, endEvent());
    proc.emit("close", 0);

    await expect(promise).resolves.toEqual({
      output,
      usage: {
        inputTokens: 19298,
        outputTokens: 442,
        cacheReadTokens: 19200,
        cacheCreationTokens: 0,
      },
    });
    expect(onMessage).toHaveBeenCalledWith("Reading a.txt");
    expect(onUsage.mock.calls.map(([usage]) => usage)).toEqual([
      {
        inputTokens: 19007,
        outputTokens: 161,
        cacheReadTokens: 128,
        cacheCreationTokens: 0,
      },
      {
        inputTokens: 19298,
        outputTokens: 442,
        cacheReadTokens: 19200,
        cacheCreationTokens: 0,
      },
      {
        inputTokens: 19298,
        outputTokens: 442,
        cacheReadTokens: 19200,
        cacheCreationTokens: 0,
      },
    ]);
  });

  it("rejects a turn that did not end normally", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = new GrokAgent({ schema }).run("test prompt", "/work/dir");
    emitJson(proc, endEvent({ stopReason: "max_turn_requests" }));
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow(
      "grok stopped with reason max_turn_requests",
    );
  });

  it("rejects structured output that does not match the schema", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = new GrokAgent({ schema }).run("test prompt", "/work/dir");
    emitJson(proc, endEvent({ structuredOutput: { success: true } }));
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow(
      "Invalid grok structuredOutput: summary is required",
    );
  });

  it.each([
    [
      "signed out",
      "Not signed in. To authenticate without a browser, run:\n  grok login --device-code",
      PermanentAgentError,
    ],
    [
      "out of credits",
      "You are out of credits or over your spending limit. Add credits and retry.",
      PermanentAgentError,
    ],
    [
      "plan rate limit",
      "Rate limited: You've hit the rate limit for your plan.",
      RateLimitAgentError,
    ],
    [
      "invalid api key",
      "Invalid API key. Check XAI_API_KEY.",
      PermanentAgentError,
    ],
    [
      "plan credit limit",
      "You've hit the credit limit for your plan.",
      PermanentAgentError,
    ],
    ["free usage limit", "You hit your free usage limit.", PermanentAgentError],
    ["weekly limit", "You hit your weekly limit.", RateLimitAgentError],
  ])(
    "classifies a %s error event exit",
    async (_label, message, errorClass) => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const promise = new GrokAgent({ schema }).run("test prompt", "/work/dir");
      emitJson(proc, { type: "error", message });
      proc.stderr.emit("data", Buffer.from(`Error: ${message}\n`));
      proc.emit("close", 1);

      await expect(promise).rejects.toBeInstanceOf(errorClass);
      if (errorClass === RateLimitAgentError) {
        await expect(promise).rejects.toMatchObject({ resumeAt: null });
      }
    },
  );

  it("keeps an unrecognized failure retryable", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = new GrokAgent({ schema }).run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "error",
      message:
        "Couldn't set model 'nope': Invalid params: \"unknown model id\".",
    });
    proc.emit("close", 1);

    const error = await promise.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermanentAgentError);
    expect(error).not.toBeInstanceOf(RateLimitAgentError);
    expect((error as Error).message).toContain(
      "grok exited with code 1: Couldn't set model 'nope'",
    );
  });

  it("shuts down a lingering grok process tree after the end event", async () => {
    vi.useFakeTimers();
    const processKill = vi
      .spyOn(process, "kill")
      .mockImplementation(() => true);
    try {
      const proc = createMockProcess();
      Object.defineProperty(proc, "pid", { value: 4321 });
      mockSpawn.mockReturnValue(proc);
      const agent = new GrokAgent({
        finalResultGraceMs: 25,
        platform: "darwin",
        schema,
      });

      const promise = agent.run("test prompt", "/work/dir");
      emitJson(proc, endEvent());

      await vi.advanceTimersByTimeAsync(24);
      expect(processKill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(processKill).toHaveBeenCalledWith(-4321, "SIGTERM");

      proc.emit("close", null);
      await expect(promise).resolves.toMatchObject({ output });
    } finally {
      processKill.mockRestore();
      vi.useRealTimers();
    }
  });

  it("kills the grok process group when aborted", async () => {
    const processKill = vi
      .spyOn(process, "kill")
      .mockImplementation(() => true);
    try {
      const proc = createMockProcess();
      Object.defineProperty(proc, "pid", { value: 6789 });
      mockSpawn.mockReturnValue(proc);
      const controller = new AbortController();

      const promise = new GrokAgent({ platform: "darwin", schema }).run(
        "test prompt",
        "/work/dir",
        { signal: controller.signal },
      );
      controller.abort();

      await expect(promise).rejects.toThrow("Agent was aborted");
      expect(processKill).toHaveBeenCalledWith(-6789, "SIGTERM");
    } finally {
      processKill.mockRestore();
    }
  });
});
