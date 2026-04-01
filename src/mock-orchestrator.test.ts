import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockOrchestrator } from "./mock-orchestrator.js";

describe("MockOrchestrator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns a copy of iterations from getState", () => {
    const orchestrator = new MockOrchestrator();

    const first = orchestrator.getState();
    first.iterations.push({
      number: 99,
      success: true,
      summary: "mutated",
      keyChanges: [],
      keyLearnings: [],
      timestamp: new Date(),
    });

    const second = orchestrator.getState();

    expect(second.iterations).toHaveLength(13);
    expect(second.iterations.some((iteration) => iteration.number === 99)).toBe(
      false,
    );
  });

  it("emits deterministic token and message updates while running", async () => {
    const orchestrator = new MockOrchestrator();
    const onState = vi.fn();
    orchestrator.on("state", onState);

    orchestrator.start();

    expect(onState).toHaveBeenCalledTimes(1);
    expect(onState.mock.calls[0]?.[0]).toMatchObject({
      totalInputTokens: 87_300_000,
      totalOutputTokens: 860_000,
      lastMessage: "Reading src/bootstrap.ts to trace the module init order",
    });

    await vi.advanceTimersByTimeAsync(1_500);
    expect(onState).toHaveBeenCalledTimes(2);
    expect(onState.mock.calls[1]?.[0]).toMatchObject({
      totalInputTokens: 87_340_000,
      totalOutputTokens: 860_200,
    });

    await vi.advanceTimersByTimeAsync(1_500);
    expect(onState).toHaveBeenCalledTimes(4);
    expect(onState.mock.calls[2]?.[0]).toMatchObject({
      lastMessage: "Let me profile the require() chain with --cpu-prof",
    });
    expect(onState.mock.calls[3]?.[0]).toMatchObject({
      totalInputTokens: 87_380_000,
      totalOutputTokens: 860_400,
    });
  });

  it("emits stopped state and cancels future timer updates", async () => {
    const orchestrator = new MockOrchestrator();
    const onState = vi.fn();
    const onStopped = vi.fn();
    orchestrator.on("state", onState);
    orchestrator.on("stopped", onStopped);

    orchestrator.start();
    orchestrator.stop();

    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(onState.mock.calls.at(-1)?.[0]).toMatchObject({ status: "stopped" });

    const callCountAfterStop = onState.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(onState).toHaveBeenCalledTimes(callCountAfterStop);
  });
});
