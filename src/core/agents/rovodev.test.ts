import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Mock } from "vitest";
import { RovoDevAgent } from "./rovodev.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";

const mockSpawn = vi.mocked(spawn);

function createMockProcess() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: null,
    kill: vi.fn(),
  });
  return proc as unknown as ChildProcessWithoutNullStreams;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("RovoDevAgent", () => {
  let fetchMock: Mock;
  let getPort: Mock;
  let schemaDir: string;
  let schemaPath: string;
  let agent: RovoDevAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    getPort = vi.fn().mockResolvedValue(8765);
    schemaDir = mkdtempSync(join(tmpdir(), "gnhf-rovodev-test-"));
    schemaPath = join(schemaDir, "output-schema.json");
    writeFileSync(
      schemaPath,
      JSON.stringify({
        type: "object",
        properties: {
          success: { type: "boolean" },
          summary: { type: "string" },
          key_changes_made: { type: "array", items: { type: "string" } },
          key_learnings: { type: "array", items: { type: "string" } },
        },
        required: ["success", "summary", "key_changes_made", "key_learnings"],
      }),
      "utf-8",
    );
    agent = new RovoDevAgent(schemaPath, {
      fetch: fetchMock as typeof fetch,
      getPort,
    });
  });

  afterEach(() => {
    rmSync(schemaDir, { recursive: true, force: true });
  });

  it("has name 'rovodev'", () => {
    expect(agent.name).toBe("rovodev");
  });

  it("starts the server, creates a session, and parses streamed JSON output", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ status: "healthy" }))
      .mockResolvedValueOnce(
        jsonResponse({
          session_id: "session-123",
          title: "gnhf",
          message: "Session created successfully",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          message: "Inline system prompt added successfully",
          prompt_set: true,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ response: "Chat message set" }))
      .mockResolvedValueOnce(
        textResponse(
          [
            "event: user-prompt",
            'data: {"content":"test","part_kind":"user-prompt"}',
            "",
            "event: part_start",
            'data: {"index":0,"part":{"content":"{\\"success\\":true","part_kind":"text"},"event_kind":"part_start"}',
            "",
            "event: part_delta",
            'data: {"index":0,"delta":{"content_delta":",\\"summary\\":\\"done\\",\\"key_changes_made\\":[\\"a\\"],\\"key_learnings\\":[\\"b\\"]}","part_delta_kind":"text"},"event_kind":"part_delta"}',
            "",
            "event: request-usage",
            'data: {"input_tokens":10,"cache_write_tokens":2,"cache_read_tokens":3,"output_tokens":4}',
            "",
            "event: close",
            "data: ",
            "",
          ].join("\n"),
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ message: "deleted" }));

    const onUsage = vi.fn();
    const onMessage = vi.fn();

    const result = await agent.run("test prompt", "/repo", {
      onUsage,
      onMessage,
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      "acli",
      ["rovodev", "serve", "--disable-session-token", "8765"],
      expect.objectContaining({
        cwd: "/repo",
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:8765/healthcheck",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:8765/v3/sessions/create",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://127.0.0.1:8765/v3/inline-system-prompt",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "http://127.0.0.1:8765/v3/set_chat_message",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      "http://127.0.0.1:8765/v3/stream_chat",
      expect.objectContaining({ method: "GET" }),
    );
    expect(
      new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get("x-session-id"),
    ).toBe("session-123");
    expect(
      new Headers(fetchMock.mock.calls[3]?.[1]?.headers).get("x-session-id"),
    ).toBe("session-123");
    const streamHeaders = new Headers(fetchMock.mock.calls[4]?.[1]?.headers);
    expect(streamHeaders.get("x-session-id")).toBe("session-123");
    expect(streamHeaders.get("accept")).toBe("text/event-stream");
    expect(result).toEqual({
      output: {
        success: true,
        summary: "done",
        key_changes_made: ["a"],
        key_learnings: ["b"],
      },
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 3,
        cacheCreationTokens: 2,
      },
    });
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheCreationTokens: 2,
    });
    expect(onMessage).toHaveBeenCalledWith(
      '{"success":true,"summary":"done","key_changes_made":["a"],"key_learnings":["b"]}',
    );
  });

  it("reuses the existing server process across runs", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ status: "healthy" }))
      .mockResolvedValueOnce(
        jsonResponse({ session_id: "session-1", title: "one" }),
      )
      .mockResolvedValueOnce(jsonResponse({ message: "ok", prompt_set: true }))
      .mockResolvedValueOnce(jsonResponse({ response: "Chat message set" }))
      .mockResolvedValueOnce(
        textResponse(
          [
            "event: part_start",
            'data: {"index":0,"part":{"content":"{\\"success\\":true,\\"summary\\":\\"one\\",\\"key_changes_made\\":[],\\"key_learnings\\":[]}","part_kind":"text"},"event_kind":"part_start"}',
            "",
            "event: request-usage",
            'data: {"input_tokens":1,"cache_write_tokens":0,"cache_read_tokens":0,"output_tokens":1}',
            "",
            "event: close",
            "data: ",
            "",
          ].join("\n"),
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ message: "deleted" }))
      .mockResolvedValueOnce(
        jsonResponse({ session_id: "session-2", title: "two" }),
      )
      .mockResolvedValueOnce(jsonResponse({ message: "ok", prompt_set: true }))
      .mockResolvedValueOnce(jsonResponse({ response: "Chat message set" }))
      .mockResolvedValueOnce(
        textResponse(
          [
            "event: part_start",
            'data: {"index":0,"part":{"content":"{\\"success\\":true,\\"summary\\":\\"two\\",\\"key_changes_made\\":[],\\"key_learnings\\":[]}","part_kind":"text"},"event_kind":"part_start"}',
            "",
            "event: request-usage",
            'data: {"input_tokens":2,"cache_write_tokens":0,"cache_read_tokens":0,"output_tokens":2}',
            "",
            "event: close",
            "data: ",
            "",
          ].join("\n"),
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ message: "deleted" }));

    await agent.run("first", "/repo");
    await agent.run("second", "/repo");

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(getPort).toHaveBeenCalledTimes(1);
  });

  it("rejects when the final text is not valid JSON", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ status: "healthy" }))
      .mockResolvedValueOnce(
        jsonResponse({ session_id: "session-123", title: "gnhf" }),
      )
      .mockResolvedValueOnce(jsonResponse({ message: "ok", prompt_set: true }))
      .mockResolvedValueOnce(jsonResponse({ response: "Chat message set" }))
      .mockResolvedValueOnce(
        textResponse(
          [
            "event: part_start",
            'data: {"index":0,"part":{"content":"not json","part_kind":"text"},"event_kind":"part_start"}',
            "",
            "event: close",
            "data: ",
            "",
          ].join("\n"),
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ message: "deleted" }));

    await expect(agent.run("test", "/repo")).rejects.toThrow(
      "Failed to parse rovodev output",
    );
  });

  it("treats text separated by tool activity as distinct message segments", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ status: "healthy" }))
      .mockResolvedValueOnce(
        jsonResponse({ session_id: "session-123", title: "gnhf" }),
      )
      .mockResolvedValueOnce(jsonResponse({ message: "ok", prompt_set: true }))
      .mockResolvedValueOnce(jsonResponse({ response: "Chat message set" }))
      .mockResolvedValueOnce(
        textResponse(
          [
            "event: part_start",
            'data: {"index":0,"part":{"content":"I will inspect the file.","part_kind":"text"},"event_kind":"part_start"}',
            "",
            "event: on_call_tools_start",
            'data: {"parts":[{"tool_name":"open_files","args":"{\\"file_paths\\":[\\"package.json\\"]}","tool_call_id":"tool-1","part_kind":"tool-call"}]}',
            "",
            "event: tool-return",
            'data: {"tool_name":"open_files","content":"ok","tool_call_id":"tool-1","part_kind":"tool-return"}',
            "",
            "event: part_start",
            'data: {"index":0,"part":{"content":"{\\"success\\":true,\\"summary\\":\\"done\\",\\"key_changes_made\\":[],\\"key_learnings\\":[]}","part_kind":"text"},"event_kind":"part_start"}',
            "",
            "event: close",
            "data: ",
            "",
          ].join("\n"),
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ message: "deleted" }));

    const onMessage = vi.fn();

    const result = await agent.run("test", "/repo", { onMessage });

    expect(onMessage).toHaveBeenNthCalledWith(1, "I will inspect the file.");
    expect(onMessage).toHaveBeenNthCalledWith(
      2,
      '{"success":true,"summary":"done","key_changes_made":[],"key_learnings":[]}',
    );
    expect(result.output.summary).toBe("done");
  });

  it("force terminates rovodev if shutdown exceeds the timeout", async () => {
    vi.useFakeTimers();
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ status: "healthy" }))
      .mockResolvedValueOnce(
        jsonResponse({ session_id: "session-123", title: "gnhf" }),
      )
      .mockResolvedValueOnce(jsonResponse({ message: "ok", prompt_set: true }))
      .mockResolvedValueOnce(jsonResponse({ response: "Chat message set" }))
      .mockResolvedValueOnce(
        textResponse(
          [
            "event: part_start",
            'data: {"index":0,"part":{"content":"{\\"success\\":true,\\"summary\\":\\"done\\",\\"key_changes_made\\":[],\\"key_learnings\\":[]}","part_kind":"text"},"event_kind":"part_start"}',
            "",
            "event: close",
            "data: ",
            "",
          ].join("\n"),
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ message: "deleted" }));

    await agent.run("test", "/repo");

    const closePromise = agent.close();
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

    await vi.advanceTimersByTimeAsync(2_999);
    expect(proc.kill).not.toHaveBeenCalledWith("SIGKILL");

    await vi.advanceTimersByTimeAsync(1);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");

    await closePromise;
    vi.useRealTimers();
  });

  it("cancels and deletes the session after an abort", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    let rejectStream!: (error: Error) => void;
    const streamResponse = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              [
                "event: part_start",
                'data: {"index":0,"part":{"content":"working","part_kind":"text"},"event_kind":"part_start"}',
                "",
              ].join("\n"),
            ),
          );
        },
        cancel() {
          // noop
        },
      }),
      {
        headers: { "content-type": "text/event-stream" },
      },
    );
    Object.defineProperty(streamResponse.body!, "getReader", {
      value: () => ({
        read: vi.fn(
          () =>
            new Promise<ReadableStreamReadResult<Uint8Array>>(
              (_resolve, reject) => {
                rejectStream = reject;
              },
            ),
        ),
      }),
    });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ status: "healthy" }))
      .mockResolvedValueOnce(
        jsonResponse({ session_id: "session-123", title: "gnhf" }),
      )
      .mockResolvedValueOnce(jsonResponse({ message: "ok", prompt_set: true }))
      .mockResolvedValueOnce(jsonResponse({ response: "Chat message set" }))
      .mockResolvedValueOnce(streamResponse)
      .mockResolvedValueOnce(jsonResponse({ message: "ok" }))
      .mockResolvedValueOnce(jsonResponse({ message: "ok" }));

    const controller = new AbortController();
    const promise = agent.run("test", "/repo", { signal: controller.signal });
    const expectation = expect(promise).rejects.toThrow("Agent was aborted");

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:8765/v3/stream_chat",
        expect.anything(),
      );
    });

    controller.abort();
    rejectStream(new DOMException("The operation was aborted.", "AbortError"));

    await expectation;

    const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calledUrls).toContain("http://127.0.0.1:8765/v3/cancel");
    expect(calledUrls).toContain(
      "http://127.0.0.1:8765/v3/sessions/session-123",
    );
  });
});
