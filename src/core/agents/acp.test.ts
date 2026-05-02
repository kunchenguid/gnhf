import { describe, it, expect, vi } from "vitest";
import { AcpAgent } from "./acp.js";
import { PermanentAgentError, type AgentOutputSchema } from "./types.js";
import type {
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeTurnInput,
  AcpRuntimeTurnResult,
} from "acpx/runtime";

const TEST_SCHEMA: AgentOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    success: { type: "boolean" },
    summary: { type: "string" },
    key_changes_made: { type: "array", items: { type: "string" } },
    key_learnings: { type: "array", items: { type: "string" } },
  },
  required: ["success", "summary", "key_changes_made", "key_learnings"],
};

const VALID_OUTPUT = {
  success: true,
  summary: "did the thing",
  key_changes_made: ["edited foo.ts"],
  key_learnings: ["learned x"],
};

const STUB_HANDLE: AcpRuntimeHandle = {
  sessionKey: "run-123",
  backend: "acpx",
  runtimeSessionName: "stub",
};

interface FakeTurn {
  events: AcpRuntimeEvent[];
  result: AcpRuntimeTurnResult;
  cancel?: () => Promise<void>;
}

interface FakeRuntimeCalls {
  ensureSessionInputs: AcpRuntimeEnsureInput[];
  startTurnInputs: AcpRuntimeTurnInput[];
  closeInputs: Array<{ handle: AcpRuntimeHandle; reason: string }>;
  cancelCalls: number;
}

function createFakeRuntime(turns: FakeTurn[]) {
  const calls: FakeRuntimeCalls = {
    ensureSessionInputs: [],
    startTurnInputs: [],
    closeInputs: [],
    cancelCalls: 0,
  };
  let turnIndex = 0;

  const runtime = {
    ensureSession: vi.fn(async (input: AcpRuntimeEnsureInput) => {
      calls.ensureSessionInputs.push(input);
      return STUB_HANDLE;
    }),
    startTurn: vi.fn((input: AcpRuntimeTurnInput) => {
      calls.startTurnInputs.push(input);
      const turn = turns[turnIndex++];
      if (!turn) throw new Error("No fake turn queued");

      // Emulate signal cancellation: if signal aborts mid-stream, the
      // returned `result` flips to "cancelled" and turn.cancel() is invoked.
      let cancelled = false;
      const onAbort = () => {
        cancelled = true;
        calls.cancelCalls += 1;
        turn.cancel?.();
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });

      const events = (async function* () {
        for (const event of turn.events) {
          if (cancelled) return;
          // Yield to the microtask queue so AbortSignal listeners can fire
          // between events.
          await Promise.resolve();
          yield event;
        }
      })();

      const result: Promise<AcpRuntimeTurnResult> = (async () => {
        // Drain any remaining events before resolving result.
        await Promise.resolve();
        if (cancelled) {
          return { status: "cancelled" } as AcpRuntimeTurnResult;
        }
        return turn.result;
      })();

      return {
        requestId: input.requestId,
        events,
        result,
        cancel: vi.fn(async () => {
          cancelled = true;
          calls.cancelCalls += 1;
        }),
        closeStream: vi.fn(async () => {}),
      };
    }),
    close: vi.fn(
      async (input: { handle: AcpRuntimeHandle; reason: string }) => {
        calls.closeInputs.push(input);
      },
    ),
    cancel: vi.fn(async () => {}),
    runTurn: vi.fn(),
    isHealthy: vi.fn(() => true),
    probeAvailability: vi.fn(async () => {}),
  };

  return { runtime, calls };
}

function textDelta(
  text: string,
  stream: "output" | "thought" = "output",
): AcpRuntimeEvent {
  return { type: "text_delta", text, stream };
}

function makeAgent(
  fakeRuntime: ReturnType<typeof createFakeRuntime>["runtime"],
  overrides: { runId?: string; target?: string } = {},
): AcpAgent {
  return new AcpAgent({
    target: overrides.target ?? "gemini",
    schema: TEST_SCHEMA,
    runId: overrides.runId ?? "run-123",
    sessionStateDir: "/tmp/acp-sessions",
    runtimeFactory: () => fakeRuntime as never,
  });
}

describe("AcpAgent", () => {
  it("exposes name with the acp:<target> prefix", () => {
    const { runtime } = createFakeRuntime([]);
    const agent = makeAgent(runtime, { target: "gemini" });
    expect(agent.name).toBe("acp:gemini");
  });

  it("ensures a persistent session keyed on runId and target, then submits a prompt turn", async () => {
    const { runtime, calls } = createFakeRuntime([
      {
        events: [textDelta(JSON.stringify(VALID_OUTPUT))],
        result: { status: "completed" },
      },
    ]);
    const agent = makeAgent(runtime);

    const result = await agent.run("do the thing", "/work");

    expect(calls.ensureSessionInputs).toHaveLength(1);
    expect(calls.ensureSessionInputs[0]).toMatchObject({
      sessionKey: "run-123",
      agent: "gemini",
      mode: "persistent",
      cwd: "/work",
    });
    expect(calls.startTurnInputs).toHaveLength(1);
    expect(calls.startTurnInputs[0]).toMatchObject({
      handle: STUB_HANDLE,
      mode: "prompt",
    });
    expect(calls.startTurnInputs[0]!.text).toContain("do the thing");
    expect(calls.startTurnInputs[0]!.text).toContain('"success"'); // schema embedded
    expect(typeof calls.startTurnInputs[0]!.requestId).toBe("string");
    expect(calls.startTurnInputs[0]!.requestId.length).toBeGreaterThan(0);
    expect(result.output).toEqual(VALID_OUTPUT);
  });

  it("accumulates text_delta events with stream:'output' across multiple chunks", async () => {
    const json = JSON.stringify(VALID_OUTPUT);
    const half = Math.floor(json.length / 2);
    const { runtime } = createFakeRuntime([
      {
        events: [textDelta(json.slice(0, half)), textDelta(json.slice(half))],
        result: { status: "completed" },
      },
    ]);
    const agent = makeAgent(runtime);

    const result = await agent.run("p", "/w");
    expect(result.output).toEqual(VALID_OUTPUT);
  });

  it("ignores text_delta events with stream:'thought'", async () => {
    const { runtime } = createFakeRuntime([
      {
        events: [
          textDelta("REASONING: blah blah", "thought"),
          textDelta(JSON.stringify(VALID_OUTPUT)),
        ],
        result: { status: "completed" },
      },
    ]);
    const agent = makeAgent(runtime);

    const result = await agent.run("p", "/w");
    expect(result.output).toEqual(VALID_OUTPUT);
  });

  it("does not let status/tool_call event text bleed into the JSON answer", async () => {
    const { runtime } = createFakeRuntime([
      {
        events: [
          {
            type: "status",
            text: "thinking",
            tag: "usage_update",
            used: 100,
            size: 200,
          },
          { type: "tool_call", text: "ran tool", toolCallId: "1" },
          textDelta(JSON.stringify(VALID_OUTPUT)),
        ],
        result: { status: "completed" },
      },
    ]);
    const agent = makeAgent(runtime);

    const result = await agent.run("p", "/w");
    expect(result.output).toEqual(VALID_OUTPUT);
  });

  it("suppresses tool_call and status text from onMessage so only assistant prose surfaces", async () => {
    const onMessage = vi.fn();
    const { runtime } = createFakeRuntime([
      {
        events: [
          { type: "tool_call", text: "Read file foo.ts", toolCallId: "1" },
          {
            type: "status",
            text: "usage updated: 100/1000",
            tag: "usage_update",
            used: 100,
            size: 1000,
          },
          textDelta(JSON.stringify(VALID_OUTPUT)),
        ],
        result: { status: "completed" },
      },
    ]);
    const agent = makeAgent(runtime);

    await agent.run("p", "/w", { onMessage });

    const messages = onMessage.mock.calls.map((args) => args[0] as string);
    // Tool descriptions and status metadata are noisy and not useful to
    // surface in the TUI - only assistant text messages should appear.
    expect(messages).not.toContain("Read file foo.ts");
    expect(messages).not.toContain("usage updated: 100/1000");
  });

  it("reports input-token usage from usage_update status events", async () => {
    const onUsage = vi.fn();
    const { runtime } = createFakeRuntime([
      {
        events: [
          {
            type: "status",
            text: "usage updated: 50/1000",
            tag: "usage_update",
            used: 50,
            size: 1000,
          },
          {
            type: "status",
            text: "usage updated: 120/1000",
            tag: "usage_update",
            used: 120,
            size: 1000,
          },
          textDelta(JSON.stringify(VALID_OUTPUT)),
        ],
        result: { status: "completed" },
      },
    ]);
    const agent = makeAgent(runtime);

    const result = await agent.run("p", "/w", { onUsage });

    expect(result.usage.inputTokens).toBe(120);
    const reported = onUsage.mock.calls.map(
      (args) => (args[0] as { inputTokens: number }).inputTokens,
    );
    // Once usage_update arrives, the reported `used` delta takes over and
    // overrides the prompt-length estimate that fires at iteration start.
    expect(reported).toContain(50);
    expect(reported).toContain(120);
    expect(reported[reported.length - 1]).toBe(120);
  });

  it("reports per-iteration deltas of `used` across iterations", async () => {
    // ACP sessions are persistent, so `used` is cumulative across the run.
    // Each iteration should report only the additional context tokens it
    // consumed, not the whole conversation context.
    const { runtime } = createFakeRuntime([
      {
        events: [
          {
            type: "status",
            text: "u",
            tag: "usage_update",
            used: 100,
            size: 1000,
          },
          textDelta(JSON.stringify(VALID_OUTPUT)),
        ],
        result: { status: "completed" },
      },
      {
        events: [
          {
            type: "status",
            text: "u",
            tag: "usage_update",
            used: 250,
            size: 1000,
          },
          textDelta(JSON.stringify(VALID_OUTPUT)),
        ],
        result: { status: "completed" },
      },
    ]);
    const agent = makeAgent(runtime);

    const first = await agent.run("p", "/w");
    const second = await agent.run("p", "/w");

    expect(first.usage.inputTokens).toBe(100);
    expect(second.usage.inputTokens).toBe(150); // 250 - 100
  });

  it("validates the parsed output against the schema", async () => {
    const { runtime } = createFakeRuntime([
      {
        events: [textDelta(JSON.stringify({ success: true, summary: "x" }))],
        result: { status: "completed" },
      },
    ]);
    const agent = makeAgent(runtime);

    await expect(agent.run("p", "/w")).rejects.toThrow(/key_changes_made/);
  });

  it("throws a clear error when the final text is not valid JSON", async () => {
    const { runtime } = createFakeRuntime([
      {
        events: [textDelta("not json at all")],
        result: { status: "completed" },
      },
    ]);
    const agent = makeAgent(runtime);

    await expect(agent.run("p", "/w")).rejects.toThrow(/parse|JSON/i);
  });

  it("strips a leading ```json fence and trailing ``` from the output", async () => {
    const fenced = `\`\`\`json\n${JSON.stringify(VALID_OUTPUT)}\n\`\`\``;
    const { runtime } = createFakeRuntime([
      {
        events: [textDelta(fenced)],
        result: { status: "completed" },
      },
    ]);
    const agent = makeAgent(runtime);

    const result = await agent.run("p", "/w");
    expect(result.output).toEqual(VALID_OUTPUT);
  });

  it("throws PermanentAgentError when the runtime reports a non-retryable failure", async () => {
    const { runtime } = createFakeRuntime([
      {
        events: [],
        result: {
          status: "failed",
          error: {
            message: "auth required for gemini",
            code: "ACP_TURN_FAILED",
            retryable: false,
          },
        },
      },
    ]);
    const agent = makeAgent(runtime);

    await expect(agent.run("p", "/w")).rejects.toBeInstanceOf(
      PermanentAgentError,
    );
  });

  it("throws a regular Error when the runtime reports a retryable failure", async () => {
    const { runtime } = createFakeRuntime([
      {
        events: [],
        result: {
          status: "failed",
          error: { message: "transient", retryable: true },
        },
      },
    ]);
    const agent = makeAgent(runtime);

    const error = await agent.run("p", "/w").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermanentAgentError);
    expect((error as Error).message).toContain("transient");
  });

  it("throws 'Agent was aborted' when the runtime reports cancellation", async () => {
    const { runtime } = createFakeRuntime([
      {
        events: [],
        result: { status: "cancelled" },
      },
    ]);
    const agent = makeAgent(runtime);

    await expect(agent.run("p", "/w")).rejects.toThrow("Agent was aborted");
  });

  it("forwards an AbortSignal so the runtime can cancel the turn", async () => {
    const controller = new AbortController();
    const { runtime, calls } = createFakeRuntime([
      {
        events: [
          textDelta("partial"),
          textDelta("more partial"),
          textDelta("never reaches here"),
        ],
        result: { status: "completed" },
      },
    ]);
    const agent = makeAgent(runtime);

    const promise = agent.run("p", "/w", { signal: controller.signal });
    queueMicrotask(() => controller.abort());

    await expect(promise).rejects.toThrow("Agent was aborted");
    // The runtime received the same AbortSignal we passed in:
    expect(calls.startTurnInputs[0]!.signal).toBe(controller.signal);
  });

  it("buffers consecutive text_delta chunks into a single onMessage call so the renderer sees full messages instead of per-token flicker", async () => {
    const onMessage = vi.fn();
    const json = JSON.stringify(VALID_OUTPUT);
    const third = Math.floor(json.length / 3);
    const { runtime } = createFakeRuntime([
      {
        events: [
          textDelta(json.slice(0, third)),
          textDelta(json.slice(third, 2 * third)),
          textDelta(json.slice(2 * third)),
        ],
        result: { status: "completed" },
      },
    ]);
    const agent = makeAgent(runtime);

    await agent.run("p", "/w", { onMessage });

    const calls = onMessage.mock.calls.map((args) => args[0] as string);
    expect(calls).toEqual([json]);
  });

  it("flushes the buffered message on a tool_call boundary so each completed assistant message surfaces once", async () => {
    const onMessage = vi.fn();
    const json = JSON.stringify(VALID_OUTPUT);
    const { runtime } = createFakeRuntime([
      {
        events: [
          textDelta("Let me "),
          textDelta("examine the "),
          textDelta("code."),
          { type: "tool_call", text: "Read foo.ts", toolCallId: "1" },
          textDelta(json),
        ],
        result: { status: "completed" },
      },
    ]);
    const agent = makeAgent(runtime);

    await agent.run("p", "/w", { onMessage });

    const calls = onMessage.mock.calls.map((args) => args[0] as string);
    // The tool_call boundary flushes the buffered prose but the tool_call
    // text itself is suppressed.
    expect(calls).toEqual(["Let me examine the code.", json]);
  });

  it("parses the last assistant message rather than concatenating intermediate prose with the final JSON", async () => {
    // This is the regression case from acp:opencode runs - intermediate
    // prose like "Let me examine..." was being concatenated with the final
    // JSON answer and JSON.parse choked on the leading prose.
    const json = JSON.stringify(VALID_OUTPUT);
    const { runtime } = createFakeRuntime([
      {
        events: [
          textDelta("Let me examine the codebase first."),
          { type: "tool_call", text: "Grep for 'foo'", toolCallId: "1" },
          textDelta("Now I have what I need."),
          { type: "tool_call", text: "Edit bar.ts", toolCallId: "2" },
          textDelta(json),
        ],
        result: { status: "completed" },
      },
    ]);
    const agent = makeAgent(runtime);

    const result = await agent.run("p", "/w");
    expect(result.output).toEqual(VALID_OUTPUT);
  });

  it("extracts a JSON object from a single uninterrupted message that mixes prose and JSON", async () => {
    // If the agent never makes a tool call, we end up with one big output
    // message containing both prose and the JSON answer. Extract the
    // rightmost balanced object out of that.
    const json = JSON.stringify(VALID_OUTPUT);
    const { runtime } = createFakeRuntime([
      {
        events: [textDelta(`Here is my answer:\n${json}\nDone.`)],
        result: { status: "completed" },
      },
    ]);
    const agent = makeAgent(runtime);

    const result = await agent.run("p", "/w");
    expect(result.output).toEqual(VALID_OUTPUT);
  });

  it("estimates non-zero output tokens from streamed text_delta chunks", async () => {
    const json = JSON.stringify(VALID_OUTPUT);
    const onUsage = vi.fn();
    const { runtime } = createFakeRuntime([
      {
        events: [textDelta(json)],
        result: { status: "completed" },
      },
    ]);
    const agent = makeAgent(runtime);

    const result = await agent.run("p", "/w", { onUsage });
    // ACP only reports a cumulative `used` context value (not split
    // input/output), so we estimate output tokens from streamed bytes.
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });

  it("counts thought-stream text toward output tokens so reasoning agents don't sit at 0", async () => {
    // Regression: agents that stream reasoning before answering (Gemini,
    // GPT-5 reasoning models, etc.) used to leave the renderer at 0 output
    // tokens for the entire thinking phase because only `output` stream
    // chars were counted. Reasoning is real generated text that consumes
    // output tokens, so it must count too.
    const onUsage = vi.fn();
    const longReasoning = "thinking ".repeat(200);
    const { runtime } = createFakeRuntime([
      {
        events: [
          textDelta(longReasoning, "thought"),
          textDelta(JSON.stringify(VALID_OUTPUT)),
        ],
        result: { status: "completed" },
      },
    ]);
    const agent = makeAgent(runtime);

    const result = await agent.run("p", "/w", { onUsage });

    const reportedOutputs = onUsage.mock.calls.map(
      (args) => (args[0] as { outputTokens: number }).outputTokens,
    );
    // The renderer should have seen the output token count rise during the
    // thinking phase, before the final JSON arrived.
    const reasoningPhaseMax = Math.max(
      0,
      ...reportedOutputs.slice(0, reportedOutputs.length - 1),
    );
    expect(reasoningPhaseMax).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(reasoningPhaseMax);
  });

  it("falls back to a prompt-length input-token estimate when no usage_update events are emitted", async () => {
    const json = JSON.stringify(VALID_OUTPUT);
    const { runtime } = createFakeRuntime([
      {
        events: [textDelta(json)],
        result: { status: "completed" },
      },
    ]);
    const agent = makeAgent(runtime);

    const result = await agent.run("p", "/w");
    // Many ACP adapters never emit usage_update; without an estimate the
    // renderer would be stuck at 0 input tokens forever.
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });

  it("reuses the same session across multiple iterations", async () => {
    const { runtime, calls } = createFakeRuntime([
      {
        events: [textDelta(JSON.stringify(VALID_OUTPUT))],
        result: { status: "completed" },
      },
      {
        events: [textDelta(JSON.stringify(VALID_OUTPUT))],
        result: { status: "completed" },
      },
    ]);
    const agent = makeAgent(runtime);

    await agent.run("first", "/w");
    await agent.run("second", "/w");

    // ensureSession is called per iteration with the same sessionKey
    // (acpx is responsible for idempotence) and the runtime is reused.
    expect(calls.ensureSessionInputs).toHaveLength(2);
    expect(calls.ensureSessionInputs[0]!.sessionKey).toBe("run-123");
    expect(calls.ensureSessionInputs[1]!.sessionKey).toBe("run-123");
    expect(calls.startTurnInputs).toHaveLength(2);
  });

  it("close() shuts down the active session via runtime.close", async () => {
    const { runtime, calls } = createFakeRuntime([
      {
        events: [textDelta(JSON.stringify(VALID_OUTPUT))],
        result: { status: "completed" },
      },
    ]);
    const agent = makeAgent(runtime);

    await agent.run("p", "/w");
    await agent.close();

    expect(calls.closeInputs).toHaveLength(1);
    expect(calls.closeInputs[0]!.handle).toBe(STUB_HANDLE);
  });

  it("close() is a no-op when no session was opened", async () => {
    const { runtime, calls } = createFakeRuntime([]);
    const agent = makeAgent(runtime);

    await agent.close();

    expect(calls.closeInputs).toHaveLength(0);
  });

  it("close() is idempotent", async () => {
    const { runtime, calls } = createFakeRuntime([
      {
        events: [textDelta(JSON.stringify(VALID_OUTPUT))],
        result: { status: "completed" },
      },
    ]);
    const agent = makeAgent(runtime);

    await agent.run("p", "/w");
    await agent.close();
    await agent.close();

    expect(calls.closeInputs).toHaveLength(1);
  });
});
