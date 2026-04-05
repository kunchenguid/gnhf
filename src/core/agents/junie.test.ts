import { describe, it, expect, vi } from "vitest";
import { JunieAgent } from "./junie.js";

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

describe("JunieAgent", () => {
  it("has the correct name", () => {
    const agent = new JunieAgent();
    expect(agent.name).toBe("junie");
  });

  it("builds args with --task", () => {
    const agent = new JunieAgent();
    const args = (agent as any).buildArgs("do something");
    expect(args).toContain("--task");
  });

  it("parses a direct JSON response", () => {
    const agent = new JunieAgent();
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
    const agent = new JunieAgent();
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
    const agent = new JunieAgent();
    const usage = (agent as any).parseUsage("");
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
  });
});
