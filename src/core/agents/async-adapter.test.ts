import { beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncAgentAdapter } from "./async-adapter.js";
import type { AsyncAgent, AsyncAgentPollResult } from "./types.js";

function createAsyncAgent(overrides: Partial<AsyncAgent> = {}): AsyncAgent {
  return {
    name: "jules",
    run: vi.fn(),
    submit: vi.fn(async () => ({
      id: "session-1",
      url: "https://example.test",
    })),
    poll: vi.fn<() => Promise<AsyncAgentPollResult>>(async () => ({
      status: "completed",
      summary: "done",
    })),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("AsyncAgentAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it("closes the async agent when polling fails", async () => {
    const asyncAgent = createAsyncAgent({
      poll: vi.fn(async () => {
        throw new Error("poll failed");
      }),
    });
    const adapter = new AsyncAgentAdapter(asyncAgent);

    await expect(adapter.run("prompt", "/cwd")).rejects.toThrow("poll failed");
    expect(asyncAgent.close).toHaveBeenCalledTimes(1);
  });

  it("aborts promptly while waiting for the next poll interval", async () => {
    const asyncAgent = createAsyncAgent({
      poll: vi
        .fn<() => Promise<AsyncAgentPollResult>>()
        .mockResolvedValueOnce({ status: "queued" })
        .mockResolvedValueOnce({ status: "completed", summary: "done" }),
    });
    const adapter = new AsyncAgentAdapter(asyncAgent, {
      pollIntervalMs: 30_000,
    });
    const controller = new AbortController();

    const promise = adapter.run("prompt", "/cwd", {
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(asyncAgent.poll).toHaveBeenCalledTimes(1);
    });
    controller.abort();

    await expect(promise).rejects.toThrow("Agent was aborted");
    expect(asyncAgent.poll).toHaveBeenCalledTimes(1);
  });
});
