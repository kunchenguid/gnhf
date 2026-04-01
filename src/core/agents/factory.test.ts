import { describe, it, expect, vi } from "vitest";

vi.mock("./claude.js", () => {
  const ClaudeAgent = vi.fn(function (this: Record<string, unknown>) {
    this.name = "claude";
  });
  return { ClaudeAgent };
});

vi.mock("./codex.js", () => {
  const CodexAgent = vi.fn(function (
    this: Record<string, unknown>,
    schemaPath: string,
  ) {
    this.name = "codex";
    this.schemaPath = schemaPath;
  });
  return { CodexAgent };
});

vi.mock("./rovodev.js", () => {
  const RovoDevAgent = vi.fn(function (
    this: Record<string, unknown>,
    schemaPath: string,
  ) {
    this.name = "rovodev";
    this.schemaPath = schemaPath;
  });
  return { RovoDevAgent };
});

import { createAgent } from "./factory.js";
import { ClaudeAgent } from "./claude.js";
import { CodexAgent } from "./codex.js";
import { RovoDevAgent } from "./rovodev.js";
import type { RunInfo } from "../run.js";

const stubRunInfo: RunInfo = {
  runId: "test-run",
  runDir: "/repo/.gnhf/runs/test-run",
  promptPath: "/repo/.gnhf/runs/test-run/PROMPT.md",
  notesPath: "/repo/.gnhf/runs/test-run/notes.md",
  schemaPath: "/repo/.gnhf/runs/test-run/schema.json",
  baseCommit: "abc123",
  baseCommitPath: "/repo/.gnhf/runs/test-run/base-commit",
};

describe("createAgent", () => {
  it("creates a ClaudeAgent when name is 'claude'", () => {
    const agent = createAgent("claude", stubRunInfo);
    expect(ClaudeAgent).toHaveBeenCalled();
    expect(agent.name).toBe("claude");
  });

  it("creates a CodexAgent when name is 'codex'", () => {
    const agent = createAgent("codex", stubRunInfo);
    expect(CodexAgent).toHaveBeenCalledWith(stubRunInfo.schemaPath);
    expect(agent.name).toBe("codex");
  });

  it("creates a RovoDevAgent when name is 'rovodev'", () => {
    const agent = createAgent("rovodev", stubRunInfo);
    expect(RovoDevAgent).toHaveBeenCalledWith(stubRunInfo.schemaPath);
    expect(agent.name).toBe("rovodev");
  });
});
