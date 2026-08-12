import { beforeEach, describe, it, expect, vi } from "vitest";
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
import { CodexAgent } from "./codex.js";

const mockSpawn = vi.mocked(spawn);
const mockAppendDebugLog = vi.mocked(appendDebugLog);

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

function threadStarted(threadId: string) {
  return { type: "thread.started", thread_id: threadId };
}

function agentMessage(text: string) {
  return {
    type: "item.completed",
    item: { type: "agent_message", text },
  };
}

function turnCompleted(inputTokens: number, outputTokens: number) {
  return {
    type: "turn.completed",
    usage: {
      input_tokens: inputTokens,
      cached_input_tokens: 0,
      output_tokens: outputTokens,
    },
  };
}

const FINAL_OUTPUT = JSON.stringify({
  success: true,
  summary: "recovered",
  key_changes_made: [],
  key_learnings: [],
});

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

  it("resumes the recorded thread once with the bare nudge when a completed turn had no agent message", async () => {
    const first = createMockProcess();
    const second = createMockProcess();
    mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const agent = new CodexAgent("/tmp/schema.json");

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(first, threadStarted("thread-abc"));
    emitJson(first, turnCompleted(10, 5));
    first.emit("close", 0);

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
    emitJson(second, agentMessage(FINAL_OUTPUT));
    emitJson(second, turnCompleted(3, 2));
    second.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { success: true, summary: "recovered" },
      usage: { inputTokens: 13, outputTokens: 7 },
    });

    expect(mockSpawn.mock.calls[1]![1]).toEqual([
      "exec",
      "resume",
      "thread-abc",
      "You did not produce a final answer. Continue and provide your final summary now.",
      "--json",
      "--output-schema",
      "/tmp/schema.json",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
    expect(mockAppendDebugLog).toHaveBeenCalledWith(
      "codex:output:continuation",
      expect.objectContaining({ attempt: 1 }),
    );
  });

  it("recovers a completed turn whose agent message is only whitespace", async () => {
    const first = createMockProcess();
    const second = createMockProcess();
    mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const agent = new CodexAgent("/tmp/schema.json");

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(first, threadStarted("thread-abc"));
    emitJson(first, agentMessage(" \n\t"));
    emitJson(first, turnCompleted(10, 5));
    first.emit("close", 0);

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
    emitJson(second, agentMessage(FINAL_OUTPUT));
    emitJson(second, turnCompleted(3, 2));
    second.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { success: true, summary: "recovered" },
    });
    expect(mockAppendDebugLog).toHaveBeenCalledWith(
      "codex:output:continuation",
      expect.objectContaining({ attempt: 1 }),
    );
  });

  it("does not re-ask when the turn never completed", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CodexAgent("/tmp/schema.json");

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, threadStarted("thread-abc"));
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("codex returned no agent message");
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockAppendDebugLog).not.toHaveBeenCalledWith(
      "codex:output:continuation",
      expect.anything(),
    );
  });

  it("does not re-ask when codex reported no thread id to resume", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CodexAgent("/tmp/schema.json");

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, turnCompleted(10, 5));
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow(/no thread id/);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  // Each of these is accepted by `codex exec` but rejected by
  // `codex exec resume`, so forwarding it would replace the accurate
  // empty-response diagnostic with a codex CLI usage error.
  it.each([
    ["--add-dir", "/shared"],
    ["-C", "/shared"],
    ["--cd", "/shared"],
    ["--sandbox", "workspace-write"],
    ["--full-auto"],
    ["--oss"],
    ["--profile", "work"],
  ])(
    "does not re-ask when configured codex args include %s",
    async (...extraArgs) => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);
      const agent = new CodexAgent("/tmp/schema.json", { extraArgs });

      const promise = agent.run("test prompt", "/work/dir");
      emitJson(proc, threadStarted("thread-abc"));
      emitJson(proc, turnCompleted(10, 5));
      proc.emit("close", 0);

      await expect(promise).rejects.toThrow(
        new RegExp(`${extraArgs[0]!.replace("-", "\\-")}.*codex exec resume`),
      );
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    },
  );

  it("does not re-ask when --ephemeral leaves no rollout to resume", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CodexAgent("/tmp/schema.json", {
      extraArgs: ["--ephemeral"],
    });

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, threadStarted("thread-abc"));
    emitJson(proc, turnCompleted(10, 5));
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow(/--ephemeral records no rollout/);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockAppendDebugLog).not.toHaveBeenCalledWith(
      "codex:output:continuation",
      expect.anything(),
    );
  });

  it("keeps the empty-response diagnostic when the continuation spawn itself fails", async () => {
    const first = createMockProcess();
    const second = createMockProcess();
    mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const agent = new CodexAgent("/tmp/schema.json");

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(first, threadStarted("thread-abc"));
    emitJson(first, turnCompleted(10, 5));
    first.emit("close", 0);

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
    second.stderr.emit(
      "data",
      Buffer.from("error: unexpected argument '--add-dir' found"),
    );
    second.emit("close", 2);

    const error = await promise.then(
      () => null,
      (err: Error) => err,
    );
    expect(error?.message).toBe("codex returned no agent message");
    expect((error?.cause as Error).message).toContain(
      "codex exited with code 2",
    );
    expect(mockAppendDebugLog).toHaveBeenCalledWith(
      "codex:output:continuation",
      expect.objectContaining({ continuationFailed: true }),
    );
  });

  it("forwards resume-compatible user args to the continuation", async () => {
    const first = createMockProcess();
    const second = createMockProcess();
    mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const agent = new CodexAgent("/tmp/schema.json", {
      extraArgs: ["--model", "gpt-5.5"],
    });

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(first, threadStarted("thread-abc"));
    emitJson(first, turnCompleted(1, 1));
    first.emit("close", 0);

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
    emitJson(second, agentMessage(FINAL_OUTPUT));
    emitJson(second, turnCompleted(1, 1));
    second.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { summary: "recovered" },
    });
    expect(mockSpawn.mock.calls[1]![1]).toEqual([
      "exec",
      "resume",
      "--model",
      "gpt-5.5",
      "thread-abc",
      "You did not produce a final answer. Continue and provide your final summary now.",
      "--json",
      "--output-schema",
      "/tmp/schema.json",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
  });

  it("fails after exactly one re-ask when the continuation is also empty", async () => {
    const first = createMockProcess();
    const second = createMockProcess();
    mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const agent = new CodexAgent("/tmp/schema.json");

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(first, threadStarted("thread-abc"));
    emitJson(first, turnCompleted(10, 5));
    first.emit("close", 0);

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
    emitJson(second, turnCompleted(1, 1));
    second.emit("close", 0);

    await expect(promise).rejects.toThrow("codex returned no agent message");
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });
});
