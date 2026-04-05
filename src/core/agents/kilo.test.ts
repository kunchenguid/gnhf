import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { KiloAgent } from "./kilo.js";

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

function sseResponse(chunks: string | string[]): Response {
  const values = Array.isArray(chunks) ? chunks : [chunks];
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of values) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

function finalMessageResponse(
  summary: string,
  usage: { input: number; output: number; read: number; write: number },
  messageId = "msg-123",
) {
  return jsonResponse({
    info: {
      id: messageId,
      sessionID: "session-123",
      role: "assistant",
      structured: {
        success: true,
        summary,
        key_changes_made: [],
        key_learnings: [],
      },
      tokens: {
        input: usage.input,
        output: usage.output,
        cache: {
          read: usage.read,
          write: usage.write,
        },
      },
    },
    parts: [
      {
        id: "part-final",
        type: "text",
        text: JSON.stringify({
          success: true,
          summary,
          key_changes_made: [],
          key_learnings: [],
        }),
        metadata: {
          openai: {
            phase: "final_answer",
          },
        },
      },
    ],
  });
}

const SSE_SESSION_IDLE = `data: {"payload":{"type":"session.idle","properties":{"sessionID":"session-123"}}}\n\n`;

describe("KiloAgent", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    fetchMock = vi.fn();
    tempDir = mkdtempSync(join(tmpdir(), "gnhf-kilo-test-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses 'kilo' as the default binary name", () => {
    const agent = new KiloAgent();
    expect(agent.name).toBe("kilo");
  });

  it("accepts a custom binary path", () => {
    const agent = new KiloAgent({ bin: "/custom/kilo" });
    expect(agent.name).toBe("kilo");
  });

  it("spawns kilo serve with correct arguments", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: "1.0.0" }))
      .mockResolvedValueOnce(jsonResponse({ id: "session-123" }))
      .mockResolvedValueOnce(sseResponse(SSE_SESSION_IDLE))
      .mockResolvedValueOnce(
        finalMessageResponse("done", {
          input: 10,
          output: 5,
          read: 0,
          write: 0,
        }),
      );

    const agent = new KiloAgent({
      fetch: fetchMock as typeof fetch,
      spawn: mockSpawn,
      getPort: async () => 9999,
      platform: "linux",
    });

    const promise = agent.run("test prompt", "/work/dir");

    setTimeout(() => proc.emit("close", 0), 10);
    await vi.advanceTimersByTimeAsync(20);

    await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      "kilo",
      expect.any(Array),
      expect.objectContaining({ shell: false, detached: true }),
    );
  });

  it("uses shell on Windows", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: "1.0.0" }))
      .mockResolvedValueOnce(jsonResponse({ id: "session-123" }))
      .mockResolvedValueOnce(sseResponse(SSE_SESSION_IDLE))
      .mockResolvedValueOnce(
        finalMessageResponse("done", {
          input: 10,
          output: 5,
          read: 0,
          write: 0,
        }),
      );

    const agent = new KiloAgent({
      fetch: fetchMock as typeof fetch,
      spawn: mockSpawn,
      getPort: async () => 9999,
      platform: "win32",
    });

    const promise = agent.run("test prompt", "/work/dir");

    setTimeout(() => proc.emit("close", 0), 10);
    await vi.advanceTimersByTimeAsync(20);

    await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      "kilo",
      expect.any(Array),
      expect.objectContaining({ shell: true, detached: false }),
    );
  });

  it("reports token usage correctly", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: "1.0.0" }))
      .mockResolvedValueOnce(jsonResponse({ id: "session-123" }))
      .mockResolvedValueOnce(sseResponse(SSE_SESSION_IDLE))
      .mockResolvedValueOnce(
        finalMessageResponse("done", {
          input: 100,
          output: 50,
          read: 20,
          write: 10,
        }),
      );

    const agent = new KiloAgent({
      fetch: fetchMock as typeof fetch,
      spawn: mockSpawn,
      getPort: async () => 9999,
    });

    const usageCalls: { inputTokens: number; outputTokens: number }[] = [];
    const result = await agent.run("test prompt", "/work/dir", {
      onUsage: (u) =>
        usageCalls.push({
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
        }),
    });

    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.usage.cacheReadTokens).toBe(20);
    expect(result.usage.cacheCreationTokens).toBe(10);
  });

  it("rejects when kilo exits before becoming ready", async () => {
    vi.useRealTimers();
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const agent = new KiloAgent({
      fetch: fetchMock as typeof fetch,
      spawn: mockSpawn,
      getPort: async () => 9999,
    });

    const promise = agent.run("test prompt", "/work/dir");

    await new Promise((resolve) => setTimeout(resolve, 50));
    (proc.stderr as EventEmitter).emit("data", Buffer.from("binary not found"));
    proc.emit("close", 1);

    await expect(promise).rejects.toThrow("kilo exited before becoming ready");
  });

  it("closes the server on close()", async () => {
    const proc = createMockProcess();
    let closeHandler: ((code: number | null) => void) | null = null;
    proc.on = vi.fn((event: string, handler: unknown) => {
      if (event === "close") {
        closeHandler = handler as (code: number | null) => void;
      }
      return proc;
    });

    mockSpawn.mockReturnValue(proc);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: "1.0.0" }))
      .mockResolvedValueOnce(jsonResponse({ id: "session-123" }))
      .mockResolvedValueOnce(sseResponse(SSE_SESSION_IDLE))
      .mockResolvedValueOnce(
        finalMessageResponse("done", {
          input: 10,
          output: 5,
          read: 0,
          write: 0,
        }),
      );

    const agent = new KiloAgent({
      fetch: fetchMock as typeof fetch,
      spawn: mockSpawn,
      getPort: async () => 9999,
      killProcess: () => {},
    });

    await agent.run("test prompt", "/work/dir");

    closeHandler?.(0);

    await agent.close();
  });
});
