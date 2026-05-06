import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("../debug-log.js", () => ({
  appendDebugLog: vi.fn(),
  initDebugLog: vi.fn(),
  serializeError: vi.fn((err: unknown) =>
    err instanceof Error
      ? { name: err.name, message: err.message }
      : { value: String(err) },
  ),
}));

import { execFileSync, spawn } from "node:child_process";
import { OpenCodeAgent } from "./opencode.js";
import { buildAgentOutputSchema } from "./types.js";

const DEFAULT_AGENT_OUTPUT_SCHEMA = buildAgentOutputSchema({
  includeStopField: false,
});

const STOP_AGENT_OUTPUT_SCHEMA = buildAgentOutputSchema({
  includeStopField: true,
});

const mockSpawn = vi.mocked(spawn);

function createMockProcess() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: null,
    kill: vi.fn((signal: number | NodeJS.Signals | undefined) => {
      void signal;
      return true;
    }),
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
  structuredOnly = false,
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
    parts: structuredOnly
      ? []
      : [
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

function promptAsyncResponse() {
  return new Response(null, { status: 204 });
}

function finalAnswerEvents(
  summary: string,
  usage: { input: number; output: number; read: number; write: number },
  messageId = "msg-123",
  sessionId = "session-123",
): string {
  return [
    `data: {"directory":"/repo","payload":{"type":"message.part.updated","properties":{"sessionID":"${sessionId}","part":{"id":"part-final","type":"text","text":"","metadata":{"openai":{"phase":"final_answer"}}}}}}`,
    "",
    `data: ${JSON.stringify({
      directory: "/repo",
      payload: {
        type: "message.part.delta",
        properties: {
          sessionID: sessionId,
          partID: "part-final",
          field: "text",
          delta: JSON.stringify({
            success: true,
            summary,
            key_changes_made: [],
            key_learnings: [],
          }),
        },
      },
    })}`,
    "",
    `data: ${JSON.stringify({
      directory: "/repo",
      payload: {
        type: "message.updated",
        properties: {
          sessionID: sessionId,
          info: {
            id: messageId,
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
              cache: { read: usage.read, write: usage.write },
            },
          },
        },
      },
    })}`,
    "",
    `data: ${JSON.stringify({
      directory: "/repo",
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: sessionId,
          part: {
            id: "finish-1",
            messageID: messageId,
            type: "step-finish",
            tokens: {
              input: usage.input,
              output: usage.output,
              cache: { read: usage.read, write: usage.write },
            },
          },
        },
      },
    })}`,
    "",
    `data: {"directory":"/repo","payload":{"type":"session.idle","properties":{"sessionID":"${sessionId}"}}}`,
    "",
  ].join("\n");
}

describe("OpenCodeAgent", () => {
  let fetchMock: Mock;
  let getPort: Mock;
  let agent: OpenCodeAgent;
  let tempDir: string;
  let originalServerUsername: string | undefined;
  let originalServerPassword: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    getPort = vi.fn().mockResolvedValue(8765);
    tempDir = mkdtempSync(join(tmpdir(), "gnhf-opencode-test-"));
    originalServerUsername = process.env.OPENCODE_SERVER_USERNAME;
    originalServerPassword = process.env.OPENCODE_SERVER_PASSWORD;
    agent = new OpenCodeAgent({
      fetch: fetchMock as typeof fetch,
      getPort,
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (originalServerUsername === undefined) {
      delete process.env.OPENCODE_SERVER_USERNAME;
    } else {
      process.env.OPENCODE_SERVER_USERNAME = originalServerUsername;
    }
    if (originalServerPassword === undefined) {
      delete process.env.OPENCODE_SERVER_PASSWORD;
    } else {
      process.env.OPENCODE_SERVER_PASSWORD = originalServerPassword;
    }
  });

  it("has name 'opencode'", () => {
    expect(agent.name).toBe("opencode");
  });

  it("strips OpenCode server auth env vars from the spawned child", async () => {
    process.env.OPENCODE_SERVER_USERNAME = "local-user";
    process.env.OPENCODE_SERVER_PASSWORD = "local-pass";

    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: "1.3.13" }))
      .mockResolvedValueOnce(jsonResponse({ id: "session-123" }))
      .mockResolvedValueOnce(
        sseResponse(
          finalAnswerEvents("done", { input: 1, output: 1, read: 0, write: 0 }),
        ),
      )
      .mockResolvedValueOnce(
        finalMessageResponse("done", {
          input: 1,
          output: 1,
          read: 0,
          write: 0,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(true));

    await agent.run("test prompt", "/repo");

    const spawnedEnv = mockSpawn.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    expect(spawnedEnv.OPENCODE_SERVER_USERNAME).toBeUndefined();
    expect(spawnedEnv.OPENCODE_SERVER_PASSWORD).toBeUndefined();
  });

  it("streams text, usage, and transcript data before the message request completes", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    let resolveMessageResponse!: (response: Response) => void;
    const messageResponse = new Promise<Response>((resolve) => {
      resolveMessageResponse = resolve;
    });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: "1.3.13" }))
      .mockResolvedValueOnce(jsonResponse({ id: "session-123" }))
      .mockResolvedValueOnce(
        sseResponse(
          finalAnswerEvents("done", {
            input: 10,
            output: 4,
            read: 3,
            write: 2,
          }),
        ),
      )
      .mockImplementationOnce(() => messageResponse)
      .mockResolvedValueOnce(jsonResponse(true));

    const onUsage = vi.fn();
    const onMessage = vi.fn();
    const logPath = join(tempDir, "iteration-1.jsonl");

    const runPromise = agent.run("test prompt", "/repo", {
      onUsage,
      onMessage,
      logPath,
    });

    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith(
        '{"success":true,"summary":"done","key_changes_made":[],"key_learnings":[]}',
      );
    });
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheCreationTokens: 2,
    });
    await vi.waitFor(() => {
      expect(readFileSync(logPath, "utf-8")).toContain("message.part.delta");
    });

    resolveMessageResponse(
      finalMessageResponse("done", { input: 10, output: 4, read: 3, write: 2 }),
    );

    const result = await runPromise;
    expect(result.output.summary).toBe("done");
  });

  it("processes a final SSE event even when EOF arrives without a trailing separator", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: "1.3.13" }))
      .mockResolvedValueOnce(jsonResponse({ id: "session-123" }))
      .mockResolvedValueOnce(
        sseResponse([
          'data: {"directory":"/repo","payload":{"type":"message.part.updated","properties":{"sessionID":"session-123","part":{"id":"finish-1","messageID":"msg-123","type":"step-finish","tokens":{"input":10,"output":4,"cache":{"read":3,"write":2}}}}}}\n\n',
          'data: {"directory":"/repo","payload":{"type":"message.part.updated","properties":{"sessionID":"session-123","part":{"id":"part-final","type":"text","text":"{\\"success\\":true,\\"summary\\":\\"done\\",\\"key_changes_made\\":[],\\"key_learnings\\":[]}","metadata":{"openai":{"phase":"final_answer"}}}}}}',
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          info: {
            id: "msg-123",
            sessionID: "session-123",
            role: "assistant",
            tokens: {
              input: 10,
              output: 4,
              cache: { read: 3, write: 2 },
            },
          },
          parts: [],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(true));

    await expect(agent.run("test prompt", "/repo")).resolves.toEqual({
      output: {
        success: true,
        summary: "done",
        key_changes_made: [],
        key_learnings: [],
      },
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 3,
        cacheCreationTokens: 2,
      },
    });
  });

  it("starts the server, creates a wildcard-approval session, and parses the final answer", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: "1.3.13" }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "session-123",
          directory: "/repo",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        }),
      )
      .mockResolvedValueOnce(
        sseResponse([
          'data: {"directory":"/repo","payload":{"type":"message.part.updated","properties":{"sessionID":"session-123","part":{"id":"part-commentary","type":"text","text":"Inspecting the repository first.","metadata":{"openai":{"phase":"commentary"}}}}}}\n\n',
          `${finalAnswerEvents("done", { input: 100, output: 20, read: 7, write: 3 })}`,
        ]),
      )
      .mockResolvedValueOnce(promptAsyncResponse())
      .mockResolvedValueOnce(jsonResponse(true));

    const onUsage = vi.fn();
    const onMessage = vi.fn();

    const result = await agent.run("test prompt", "/repo", {
      onUsage,
      onMessage,
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      "opencode",
      ["serve", "--hostname", "127.0.0.1", "--port", "8765", "--print-logs"],
      expect.objectContaining({
        cwd: "/repo",
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:8765/global/health",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:8765/session",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://127.0.0.1:8765/global/event",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "http://127.0.0.1:8765/session/session-123/prompt_async",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      "http://127.0.0.1:8765/session/session-123",
      expect.objectContaining({ method: "DELETE" }),
    );

    const createSessionBody = JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body ?? ""),
    );
    expect(createSessionBody).toEqual({
      directory: "/repo",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    });

    const messageBody = JSON.parse(
      String(fetchMock.mock.calls[3]?.[1]?.body ?? ""),
    );
    expect(messageBody.role).toBe("user");
    expect(messageBody.parts).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("test prompt"),
      }),
    ]);
    expect(messageBody.parts[0]?.text).toContain("reply with only valid JSON");
    expect(messageBody.format).toEqual({
      type: "json_schema",
      schema: DEFAULT_AGENT_OUTPUT_SCHEMA,
      retryCount: 1,
    });
    expect(
      new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get("accept"),
    ).toBe("text/event-stream");

    expect(result).toEqual({
      output: {
        success: true,
        summary: "done",
        key_changes_made: [],
        key_learnings: [],
      },
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 7,
        cacheCreationTokens: 3,
      },
    });
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 7,
      cacheCreationTokens: 3,
    });
    expect(onMessage).toHaveBeenNthCalledWith(
      1,
      "Inspecting the repository first.",
    );
    expect(onMessage).toHaveBeenCalledWith(
      '{"success":true,"summary":"done","key_changes_made":[],"key_learnings":[]}',
    );
  });

  it("uses the configured schema in both the prompt text and request format", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const configuredAgent = new OpenCodeAgent({
      fetch: fetchMock as typeof fetch,
      getPort,
      schema: STOP_AGENT_OUTPUT_SCHEMA,
    });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: "1.3.13" }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "session-123",
          directory: "/repo",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        }),
      )
      .mockResolvedValueOnce(
        sseResponse(
          finalAnswerEvents("done", {
            input: 100,
            output: 20,
            read: 0,
            write: 0,
          }),
        ),
      )
      .mockResolvedValueOnce(promptAsyncResponse())
      .mockResolvedValueOnce(jsonResponse(true));

    await configuredAgent.run("test prompt", "/repo");

    const messageBody = JSON.parse(
      String(fetchMock.mock.calls[3]?.[1]?.body ?? ""),
    );
    expect(messageBody.parts[0]?.text).toContain(
      JSON.stringify(STOP_AGENT_OUTPUT_SCHEMA),
    );
    expect(messageBody.format).toEqual({
      type: "json_schema",
      schema: STOP_AGENT_OUTPUT_SCHEMA,
      retryCount: 1,
    });
  });

  it("passes configured extra args through to opencode serve", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const configuredAgent = new OpenCodeAgent({
      extraArgs: ["--model", "gpt-5"],
      fetch: fetchMock as typeof fetch,
      getPort,
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ healthy: true, version: "1.3.13" }),
    );

    await expect(
      configuredAgent["ensureServer"]("/repo"),
    ).resolves.toMatchObject({
      cwd: "/repo",
      port: 8765,
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      "opencode",
      [
        "serve",
        "--model",
        "gpt-5",
        "--hostname",
        "127.0.0.1",
        "--port",
        "8765",
        "--print-logs",
      ],
      expect.objectContaining({
        cwd: "/repo",
      }),
    );
  });

  it("uses a shell on Windows so PATH-resolved .cmd shims can launch", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const windowsAgent = new OpenCodeAgent({
      fetch: fetchMock as typeof fetch,
      getPort,
      platform: "win32",
    });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: "1.3.13" }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "session-123",
          directory: "/repo",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        }),
      )
      .mockResolvedValueOnce(
        sseResponse(
          finalAnswerEvents("done", {
            input: 1,
            output: 1,
            read: 0,
            write: 0,
          }),
        ),
      )
      .mockResolvedValueOnce(
        finalMessageResponse("done", {
          input: 1,
          output: 1,
          read: 0,
          write: 0,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(true));

    await windowsAgent.run("test prompt", "/repo");

    expect(mockSpawn).toHaveBeenCalledWith(
      "opencode",
      ["serve", "--hostname", "127.0.0.1", "--port", "8765", "--print-logs"],
      expect.objectContaining({
        cwd: "/repo",
        detached: false,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  });

  it("kills the full process tree on Windows so the opencode server does not survive shutdown", async () => {
    const proc = createMockProcess();
    Object.defineProperty(proc, "pid", { value: 5678 });
    mockSpawn.mockReturnValue(proc);

    const windowsAgent = new OpenCodeAgent({
      fetch: fetchMock as typeof fetch,
      getPort,
      platform: "win32",
    });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: "1.3.13" }))
      .mockResolvedValueOnce(jsonResponse({ id: "session-123" }))
      .mockResolvedValueOnce(
        sseResponse(
          finalAnswerEvents("done", { input: 1, output: 1, read: 0, write: 0 }),
        ),
      )
      .mockResolvedValueOnce(
        finalMessageResponse("done", {
          input: 1,
          output: 1,
          read: 0,
          write: 0,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(true));

    await windowsAgent.run("test", "/repo");
    await windowsAgent.close();

    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      "taskkill",
      ["/T", "/F", "/PID", "5678"],
      { stdio: "ignore" },
    );
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("reuses the existing server process across runs in the same cwd", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: "1.3.13" }))
      .mockResolvedValueOnce(jsonResponse({ id: "session-123" }))
      .mockResolvedValueOnce(
        sseResponse(
          finalAnswerEvents("one", { input: 1, output: 1, read: 0, write: 0 }),
        ),
      )
      .mockResolvedValueOnce(
        finalMessageResponse("one", { input: 1, output: 1, read: 0, write: 0 }),
      )
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse({ id: "session-123" }))
      .mockResolvedValueOnce(
        sseResponse(
          finalAnswerEvents("two", { input: 2, output: 2, read: 0, write: 0 }),
        ),
      )
      .mockResolvedValueOnce(
        finalMessageResponse("two", { input: 2, output: 2, read: 0, write: 0 }),
      )
      .mockResolvedValueOnce(jsonResponse(true));

    await agent.run("first", "/repo-one");
    await agent.run("second", "/repo-one");

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(getPort).toHaveBeenCalledTimes(1);

    const secondCreateSessionBody = JSON.parse(
      String(fetchMock.mock.calls[5]?.[1]?.body ?? ""),
    );
    expect(secondCreateSessionBody.directory).toBe("/repo-one");
  });

  it("restarts the server when cwd changes between runs", async () => {
    const firstProc = createMockProcess();
    const secondProc = createMockProcess();
    firstProc.kill = vi.fn(() => {
      firstProc.emit("close", 0, null);
      return true;
    }) as typeof firstProc.kill;
    mockSpawn.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);
    getPort.mockResolvedValueOnce(8765).mockResolvedValueOnce(8766);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: "1.3.13" }))
      .mockResolvedValueOnce(jsonResponse({ id: "session-123" }))
      .mockResolvedValueOnce(
        sseResponse(
          finalAnswerEvents("one", { input: 1, output: 1, read: 0, write: 0 }),
        ),
      )
      .mockResolvedValueOnce(promptAsyncResponse())
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: "1.3.13" }))
      .mockResolvedValueOnce(jsonResponse({ id: "session-456" }))
      .mockResolvedValueOnce(
        sseResponse(
          finalAnswerEvents(
            "two",
            { input: 2, output: 2, read: 0, write: 0 },
            "msg-456",
            "session-456",
          ),
        ),
      )
      .mockResolvedValueOnce(promptAsyncResponse())
      .mockResolvedValueOnce(jsonResponse(true));

    await agent.run("first", "/repo-one");
    await agent.run("second", "/repo-two");

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(getPort).toHaveBeenCalledTimes(2);
    expect(firstProc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(mockSpawn.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({ cwd: "/repo-two" }),
    );
  });

  it("accumulates token usage across multiple assistant messages in one session", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: "1.3.13" }))
      .mockResolvedValueOnce(jsonResponse({ id: "session-123" }))
      .mockResolvedValueOnce(
        sseResponse([
          'data: {"directory":"/repo","payload":{"type":"message.updated","properties":{"sessionID":"session-123","info":{"id":"msg-1","role":"assistant","tokens":{"input":0,"output":0,"cache":{"read":0,"write":0}}}}}}\n\n',
          'data: {"directory":"/repo","payload":{"type":"message.part.updated","properties":{"sessionID":"session-123","part":{"id":"finish-1","messageID":"msg-1","type":"step-finish","tokens":{"input":10,"output":4,"cache":{"read":3,"write":2}}}}}}\n\n',
          'data: {"directory":"/repo","payload":{"type":"message.updated","properties":{"sessionID":"session-123","info":{"id":"msg-2","role":"assistant","tokens":{"input":0,"output":0,"cache":{"read":0,"write":0}}}}}}\n\n',
          'data: {"directory":"/repo","payload":{"type":"message.part.updated","properties":{"sessionID":"session-123","part":{"id":"part-final","type":"text","text":"{\\"success\\":true,\\"summary\\":\\"done\\",\\"key_changes_made\\":[],\\"key_learnings\\":[]}","metadata":{"openai":{"phase":"final_answer"}}}}}}\n\n',
          'data: {"directory":"/repo","payload":{"type":"message.updated","properties":{"sessionID":"session-123","info":{"id":"msg-2","role":"assistant","structured":{"success":true,"summary":"done","key_changes_made":[],"key_learnings":[]},"tokens":{"input":20,"output":6,"cache":{"read":5,"write":1}}}}}}\n\n',
          'data: {"directory":"/repo","payload":{"type":"message.part.updated","properties":{"sessionID":"session-123","part":{"id":"finish-2","messageID":"msg-2","type":"step-finish","tokens":{"input":20,"output":6,"cache":{"read":5,"write":1}}}}}}\n\n',
          'data: {"directory":"/repo","payload":{"type":"session.idle","properties":{"sessionID":"session-123"}}}\n\n',
        ]),
      )
      .mockResolvedValueOnce(promptAsyncResponse())
      .mockResolvedValueOnce(jsonResponse(true));

    const onUsage = vi.fn();

    const result = await agent.run("test", "/repo", { onUsage });

    expect(onUsage).toHaveBeenNthCalledWith(1, {
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheCreationTokens: 2,
    });
    expect(onUsage).toHaveBeenNthCalledWith(2, {
      inputTokens: 30,
      outputTokens: 10,
      cacheReadTokens: 8,
      cacheCreationTokens: 3,
    });
    expect(result.usage).toEqual({
      inputTokens: 30,
      outputTokens: 10,
      cacheReadTokens: 8,
      cacheCreationTokens: 3,
    });
  });

  it("rejects when the final text is not valid JSON", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: "1.3.13" }))
      .mockResolvedValueOnce(jsonResponse({ id: "session-123" }))
      .mockResolvedValueOnce(
        sseResponse([
          'data: {"directory":"/repo","payload":{"type":"message.part.updated","properties":{"sessionID":"session-123","part":{"id":"part-final","type":"text","text":"not json","metadata":{"openai":{"phase":"final_answer"}}}}}}\n\n',
          'data: {"directory":"/repo","payload":{"type":"session.idle","properties":{"sessionID":"session-123"}}}\n\n',
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          info: {
            id: "msg-123",
            sessionID: "session-123",
            role: "assistant",
          },
          parts: [{ type: "text", text: "not json" }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(true));

    await expect(agent.run("test", "/repo")).rejects.toThrow(
      "Failed to parse opencode output",
    );
  });

  it("rejects with 'OpenCode produced no final answer' when the stream ends with no structured output and no final_answer text", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: "1.3.13" }))
      .mockResolvedValueOnce(jsonResponse({ id: "session-123" }))
      .mockResolvedValueOnce(
        sseResponse([
          'data: {"directory":"/repo","payload":{"type":"message.part.updated","properties":{"sessionID":"session-123","part":{"id":"finish-1","type":"step-finish","tokens":{"input":1,"output":1,"cache":{"read":0,"write":0}}}}}}\n\n',
          'data: {"directory":"/repo","payload":{"type":"session.idle","properties":{"sessionID":"session-123"}}}\n\n',
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          info: {
            tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
          },
          parts: [{ type: "step-start" }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(true));

    await expect(agent.run("test", "/repo")).rejects.toThrow(
      "OpenCode produced no final answer",
    );
  });

  it("does not fall back to reasoning-phase text when no final_answer text was emitted", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: "1.3.13" }))
      .mockResolvedValueOnce(jsonResponse({ id: "session-123" }))
      .mockResolvedValueOnce(
        sseResponse([
          'data: {"directory":"/repo","payload":{"type":"message.part.updated","properties":{"sessionID":"session-123","part":{"id":"part-reasoning","type":"text","text":"**Writing a failing test**","metadata":{"openai":{"phase":"commentary"}}}}}}\n\n',
          'data: {"directory":"/repo","payload":{"type":"session.idle","properties":{"sessionID":"session-123"}}}\n\n',
        ]),
      )
      .mockResolvedValueOnce(promptAsyncResponse())
      .mockResolvedValueOnce(jsonResponse(true));

    await expect(agent.run("test", "/repo")).rejects.toThrow(
      "OpenCode produced no final answer",
    );
  });

  it("does not fall back to echoed user-prompt text when no final_answer text was emitted", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    // Simulates OpenCode echoing the user prompt back as a part with no
    // phase metadata. This used to leak into the fallback parse path and
    // got reported as `Failed to parse opencode output:` (issue #141).
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: "1.3.13" }))
      .mockResolvedValueOnce(jsonResponse({ id: "session-123" }))
      .mockResolvedValueOnce(
        sseResponse([
          'data: {"directory":"/repo","payload":{"type":"message.part.updated","properties":{"sessionID":"session-123","part":{"id":"part-echo","type":"text","text":"please ship the feature"}}}}\n\n',
          'data: {"directory":"/repo","payload":{"type":"session.idle","properties":{"sessionID":"session-123"}}}\n\n',
        ]),
      )
      .mockResolvedValueOnce(promptAsyncResponse())
      .mockResolvedValueOnce(jsonResponse(true));

    await expect(agent.run("test", "/repo")).rejects.toThrow(
      "OpenCode produced no final answer",
    );
  });

  it("prefers structured output from message.updated over final_answer text", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: "1.3.13" }))
      .mockResolvedValueOnce(jsonResponse({ id: "session-123" }))
      .mockResolvedValueOnce(
        sseResponse([
          // final_answer text would be unparseable on its own.
          'data: {"directory":"/repo","payload":{"type":"message.part.updated","properties":{"sessionID":"session-123","part":{"id":"part-final","type":"text","text":"not json","metadata":{"openai":{"phase":"final_answer"}}}}}}\n\n',
          // But message.updated with `info.structured` should win.
          'data: {"directory":"/repo","payload":{"type":"message.updated","properties":{"sessionID":"session-123","info":{"id":"msg-1","role":"assistant","structured":{"success":true,"summary":"from-structured","key_changes_made":[],"key_learnings":[]},"tokens":{"input":1,"output":1,"cache":{"read":0,"write":0}}}}}}\n\n',
          'data: {"directory":"/repo","payload":{"type":"session.idle","properties":{"sessionID":"session-123"}}}\n\n',
        ]),
      )
      .mockResolvedValueOnce(promptAsyncResponse())
      .mockResolvedValueOnce(jsonResponse(true));

    const result = await agent.run("test", "/repo");
    expect(result.output.summary).toBe("from-structured");
  });

  it("surfaces a top-level provider-overload error event as a clear retryable error", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    // Reproduces the SSE shape from issue #141: a top-level error frame
    // with no payload wrapper.
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: "1.3.13" }))
      .mockResolvedValueOnce(jsonResponse({ id: "session-123" }))
      .mockResolvedValueOnce(
        sseResponse([
          `data: ${JSON.stringify({
            type: "error",
            sequence_number: 2,
            error: {
              type: "service_unavailable_error",
              code: "server_is_overloaded",
              message:
                "Our servers are currently overloaded. Please try again later.",
              param: null,
            },
          })}\n\n`,
        ]),
      )
      .mockResolvedValueOnce(promptAsyncResponse())
      .mockResolvedValueOnce(jsonResponse(true));

    await expect(agent.run("test", "/repo")).rejects.toThrow(
      /OpenCode provider overloaded: Our servers are currently overloaded/,
    );
  });

  it("does not throw a JSON parse error when an overload event arrives mid-stream alongside reasoning text", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: "1.3.13" }))
      .mockResolvedValueOnce(jsonResponse({ id: "session-123" }))
      .mockResolvedValueOnce(
        sseResponse([
          'data: {"directory":"/repo","payload":{"type":"message.part.updated","properties":{"sessionID":"session-123","part":{"id":"part-reasoning","type":"text","text":"**Writing a failing test**","metadata":{"openai":{"phase":"commentary"}}}}}}\n\n',
          `data: ${JSON.stringify({
            type: "error",
            error: {
              type: "service_unavailable_error",
              code: "server_is_overloaded",
              message: "Our servers are currently overloaded.",
            },
          })}\n\n`,
        ]),
      )
      .mockResolvedValueOnce(promptAsyncResponse())
      .mockResolvedValueOnce(jsonResponse(true));

    const error = await agent.run("test", "/repo").then(
      () => null,
      (err: unknown) => err as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/OpenCode provider overloaded/);
    expect(error?.message).not.toMatch(/Failed to parse opencode output/);
  });

  it("surfaces a payload-wrapped session.error event as a clear error", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: "1.3.13" }))
      .mockResolvedValueOnce(jsonResponse({ id: "session-123" }))
      .mockResolvedValueOnce(
        sseResponse([
          `data: ${JSON.stringify({
            payload: {
              type: "session.error",
              properties: {
                sessionID: "session-123",
                error: {
                  type: "service_unavailable_error",
                  code: "server_is_overloaded",
                  message: "wrapped overload",
                },
              },
            },
          })}\n\n`,
        ]),
      )
      .mockResolvedValueOnce(promptAsyncResponse())
      .mockResolvedValueOnce(jsonResponse(true));

    await expect(agent.run("test", "/repo")).rejects.toThrow(
      /OpenCode provider overloaded: wrapped overload/,
    );
  });

  it("ignores payload-wrapped session.error events for other sessions", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: "1.3.13" }))
      .mockResolvedValueOnce(jsonResponse({ id: "session-123" }))
      .mockResolvedValueOnce(
        sseResponse([
          `data: ${JSON.stringify({
            payload: {
              type: "session.error",
              properties: {
                sessionID: "other-session",
                error: {
                  type: "service_unavailable_error",
                  code: "server_is_overloaded",
                  message: "other session overload",
                },
              },
            },
          })}\n\n`,
          'data: {"directory":"/repo","payload":{"type":"message.part.updated","properties":{"sessionID":"session-123","part":{"id":"part-final","type":"text","text":"{\\"success\\":true,\\"summary\\":\\"done\\",\\"key_changes_made\\":[],\\"key_learnings\\":[]}","metadata":{"openai":{"phase":"final_answer"}}}}}}\n\n',
          'data: {"directory":"/repo","payload":{"type":"session.idle","properties":{"sessionID":"session-123"}}}\n\n',
        ]),
      )
      .mockResolvedValueOnce(promptAsyncResponse())
      .mockResolvedValueOnce(jsonResponse(true));

    const result = await agent.run("test", "/repo");
    expect(result.output.summary).toBe("done");
  });

  it("force terminates opencode if shutdown exceeds the timeout", async () => {
    vi.useFakeTimers();
    const proc = createMockProcess();
    vi.mocked(proc.kill).mockImplementation(
      (signal?: number | NodeJS.Signals) => {
        if (signal === "SIGKILL") {
          queueMicrotask(() => {
            proc.emit("close", 0, null);
          });
        }
        return true;
      },
    );
    mockSpawn.mockReturnValue(proc);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: "1.3.13" }))
      .mockResolvedValueOnce(jsonResponse({ id: "session-123" }))
      .mockResolvedValueOnce(
        sseResponse(
          finalAnswerEvents("done", { input: 1, output: 1, read: 0, write: 0 }),
        ),
      )
      .mockResolvedValueOnce(
        finalMessageResponse("done", {
          input: 1,
          output: 1,
          read: 0,
          write: 0,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(true));

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

  it("aborts the session before deleting it and normalizes abort errors", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    let rejectStreamRead!: (error: unknown) => void;
    const streamResponse = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"directory":"/repo","payload":{"type":"message.part.updated","properties":{"sessionID":"session-123","part":{"id":"part-1","type":"text","text":"working"}}}}\n\n',
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
                rejectStreamRead = reject;
              },
            ),
        ),
        cancel: vi.fn(() => Promise.resolve()),
      }),
    });

    let rejectMessageRequest!: (reason?: unknown) => void;
    const messageRequest = new Promise<Response>((_resolve, reject) => {
      rejectMessageRequest = reject;
    });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: "1.3.13" }))
      .mockResolvedValueOnce(jsonResponse({ id: "session-123" }))
      .mockResolvedValueOnce(streamResponse)
      .mockImplementationOnce(() => messageRequest)
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse(true));

    const controller = new AbortController();
    const runPromise = agent.run("test", "/repo", {
      signal: controller.signal,
    });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    controller.abort();
    const abortError = new DOMException(
      "This operation was aborted",
      "AbortError",
    );
    rejectMessageRequest(abortError);
    rejectStreamRead(abortError);

    await expect(runPromise).rejects.toThrow("Agent was aborted");
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      "http://127.0.0.1:8765/session/session-123/abort",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      "http://127.0.0.1:8765/session/session-123",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
