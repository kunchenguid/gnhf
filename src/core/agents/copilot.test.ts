import { describe, it, expect, vi } from "vitest";
import { CopilotAgent } from "./copilot.js";

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

describe("CopilotAgent", () => {
  it("has the correct name", () => {
    const agent = new CopilotAgent();
    expect(agent.name).toBe("copilot");
  });

  it("builds args with --autopilot --yolo", () => {
    const agent = new CopilotAgent();
    const args = (agent as any).buildArgs("do something");
    expect(args).toContain("--autopilot");
    expect(args).toContain("--yolo");
    expect(args).toContain("--max-autopilot-continues");
    expect(args).toContain("50");
    expect(args).toContain("-p");
  });

  it("parses a direct JSON response", () => {
    const agent = new CopilotAgent();
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
    const agent = new CopilotAgent();
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
    const agent = new CopilotAgent();
    const usage = (agent as any).parseUsage("");
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
  });
});
