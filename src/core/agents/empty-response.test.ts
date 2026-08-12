import { describe, expect, it, vi } from "vitest";

vi.mock("../debug-log.js", () => ({
  appendDebugLog: vi.fn(),
  serializeError: vi.fn(),
}));

import { appendDebugLog } from "../debug-log.js";
import {
  EmptyAgentResponseError,
  runTurnWithEmptyResponseRetry,
} from "./empty-response.js";
import type { TokenUsage } from "./types.js";

function usage(inputTokens: number, outputTokens: number): TokenUsage {
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

describe("runTurnWithEmptyResponseRetry", () => {
  it("does not start or log a continuation after usage aborts the run", async () => {
    const controller = new AbortController();
    const runTurn = vi.fn().mockRejectedValue(
      new EmptyAgentResponseError("empty", {
        turnCompleted: true,
        usage: usage(10, 5),
      }),
    );

    await expect(
      runTurnWithEmptyResponseRetry({
        logEvent: "agent:continuation",
        onUsage: () => controller.abort(),
        signal: controller.signal,
        initialText: "prompt",
        runTurn,
      }),
    ).rejects.toThrow("Agent was aborted");

    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(appendDebugLog).not.toHaveBeenCalled();
  });

  it("preserves cumulative usage when the continuation is also empty", async () => {
    const firstUsage = usage(10, 5);
    const continuationUsage = usage(3, 2);
    const onUsage = vi.fn();
    const runTurn = vi
      .fn()
      .mockRejectedValueOnce(
        new EmptyAgentResponseError("first empty", {
          turnCompleted: true,
          usage: firstUsage,
        }),
      )
      .mockRejectedValueOnce(
        new EmptyAgentResponseError("continuation empty", {
          turnCompleted: true,
          usage: continuationUsage,
        }),
      );

    const error = await runTurnWithEmptyResponseRetry({
      logEvent: "agent:continuation",
      onUsage,
      initialText: "prompt",
      runTurn,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EmptyAgentResponseError);
    expect(error).toMatchObject({
      message: "continuation empty",
      usage: usage(13, 7),
    });
    expect(onUsage).toHaveBeenLastCalledWith(usage(13, 7));
    expect(runTurn).toHaveBeenCalledTimes(2);
  });

  it("surfaces a token abort after publishing cumulative empty usage", async () => {
    const controller = new AbortController();
    const onUsage = vi.fn((reported: TokenUsage) => {
      if (reported.inputTokens + reported.outputTokens >= 20) {
        controller.abort();
      }
    });
    const runTurn = vi
      .fn()
      .mockRejectedValueOnce(
        new EmptyAgentResponseError("first empty", {
          turnCompleted: true,
          usage: usage(10, 5),
        }),
      )
      .mockRejectedValueOnce(
        new EmptyAgentResponseError("continuation empty", {
          turnCompleted: true,
          usage: usage(3, 2),
        }),
      );

    const error = await runTurnWithEmptyResponseRetry({
      logEvent: "agent:continuation",
      onUsage,
      signal: controller.signal,
      initialText: "prompt",
      runTurn,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EmptyAgentResponseError);
    expect(error).toMatchObject({
      message: "Agent was aborted",
      usage: usage(13, 7),
    });
    expect(onUsage).toHaveBeenLastCalledWith(usage(13, 7));
    expect(runTurn).toHaveBeenCalledTimes(2);
  });

  it("rejects a successful continuation after cumulative usage aborts", async () => {
    const controller = new AbortController();
    const onUsage = vi.fn((reported: TokenUsage) => {
      if (reported.inputTokens + reported.outputTokens >= 20) {
        controller.abort();
      }
    });
    const continuationUsage = usage(3, 2);
    const runTurn = vi
      .fn()
      .mockRejectedValueOnce(
        new EmptyAgentResponseError("first empty", {
          turnCompleted: true,
          usage: usage(10, 5),
        }),
      )
      .mockImplementationOnce(
        async (_text: string, onTurnUsage: (usage: TokenUsage) => void) => {
          onTurnUsage(continuationUsage);
          return {
            output: {
              success: true,
              summary: "recovered",
              key_changes_made: [],
              key_learnings: [],
            },
            usage: continuationUsage,
          };
        },
      );

    await expect(
      runTurnWithEmptyResponseRetry({
        logEvent: "agent:continuation",
        onUsage,
        signal: controller.signal,
        initialText: "prompt",
        runTurn,
      }),
    ).rejects.toThrow("Agent was aborted");

    expect(onUsage).toHaveBeenLastCalledWith(usage(13, 7));
    expect(runTurn).toHaveBeenCalledTimes(2);
  });
});
