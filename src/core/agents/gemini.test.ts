import { describe, it, expect, vi } from "vitest";
import { GeminiAgent } from "./gemini.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
    pid: 12345,
  })),
  execFileSync: vi.fn(),
}));

describe("GeminiAgent", () => {
  it("has the correct name", () => {
    const agent = new GeminiAgent();
    expect(agent.name).toBe("gemini");
  });

  it("builds args with --output-format json", () => {
    const agent = new GeminiAgent();
    const args = (agent as any).buildArgs("do something");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).toContain("-p");
  });

  it("parses a wrapped response with { response: '...' }", () => {
    const agent = new GeminiAgent();
    const wrapped = JSON.stringify({
      response: JSON.stringify({
        success: true,
        summary: "done",
        key_changes_made: ["changed foo"],
        key_learnings: ["learned bar"],
      }),
    });
    const result = (agent as any).parseOutput(wrapped);
    expect(result.success).toBe(true);
    expect(result.summary).toBe("done");
  });

  it("parses a direct JSON response", () => {
    const agent = new GeminiAgent();
    const direct = JSON.stringify({
      success: true,
      summary: "done directly",
      key_changes_made: [],
      key_learnings: [],
    });
    const result = (agent as any).parseOutput(direct);
    expect(result.success).toBe(true);
    expect(result.summary).toBe("done directly");
  });

  it("extracts JSON from fenced code blocks", () => {
    const agent = new GeminiAgent();
    const fenced = [
      "Some thinking here...",
      "```json",
      '{"success":true,"summary":"fenced","key_changes_made":[],"key_learnings":[]}',
      "```",
    ].join("\n");
    const result = (agent as any).parseOutput(fenced);
    expect(result.success).toBe(true);
    expect(result.summary).toBe("fenced");
  });

  it("returns zero usage", () => {
    const agent = new GeminiAgent();
    const usage = (agent as any).parseUsage("");
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
  });
});
