import { describe, it, expect } from "vitest";
import { buildIterationPrompt } from "./iteration-prompt.js";

describe("buildIterationPrompt", () => {
  it("includes the iteration number", () => {
    const result = buildIterationPrompt({
      n: 3,
      runId: "test-run-123",
      prompt: "fix all bugs",
    });
    expect(result).toContain("iteration 3");
  });

  it("includes the run ID in the notes path", () => {
    const result = buildIterationPrompt({
      n: 1,
      runId: "my-run-abc",
      prompt: "do stuff",
    });
    expect(result).toContain(".gnhf/runs/my-run-abc/notes.md");
  });

  it("includes the objective prompt at the end", () => {
    const prompt = "improve test coverage";
    const result = buildIterationPrompt({
      n: 1,
      runId: "run-1",
      prompt,
    });
    expect(result).toContain("## Objective");
    expect(result.trimEnd().endsWith(prompt)).toBe(true);
  });

  it("includes instructions about reading notes and focusing on small units", () => {
    const result = buildIterationPrompt({
      n: 1,
      runId: "run-1",
      prompt: "test",
    });
    expect(result).toContain("Read .gnhf/runs/");
    expect(result).toContain("smallest logical unit");
  });

  it("injects Jules guidance when Jules tooling is available", () => {
    const result = buildIterationPrompt({
      n: 1,
      runId: "run-1",
      prompt: "test",
      julesGuidance: "Jules is available for remote delegation.",
    });

    expect(result).toContain("Jules is available for remote delegation.");
  });

  it("omits Jules guidance when Jules tooling is unavailable", () => {
    const result = buildIterationPrompt({
      n: 1,
      runId: "run-1",
      prompt: "test",
    });

    expect(result).not.toContain("Jules CLI/tooling is available");
  });
});
