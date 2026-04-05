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

vi.mock("./opencode.js", () => {
  const ServeBasedAgent = vi.fn(function (
    this: Record<string, unknown>,
    deps: { name?: string } = {},
  ) {
    this.name = deps.name ?? "serve-agent";
  });
  const OpenCodeAgent = vi.fn(function (this: Record<string, unknown>) {
    this.name = "opencode";
  });
  return { ServeBasedAgent, OpenCodeAgent };
});

vi.mock("./gemini.js", () => {
  const GeminiAgent = vi.fn(function (this: Record<string, unknown>) {
    this.name = "gemini";
  });
  return { GeminiAgent };
});

vi.mock("./copilot.js", () => {
  const CopilotAgent = vi.fn(function (this: Record<string, unknown>) {
    this.name = "copilot";
  });
  return { CopilotAgent };
});

vi.mock("./junie.js", () => {
  const JunieAgent = vi.fn(function (this: Record<string, unknown>) {
    this.name = "junie";
  });
  return { JunieAgent };
});

import { createAgent } from "./factory.js";
import { ClaudeAgent } from "./claude.js";
import { CodexAgent } from "./codex.js";
import { OpenCodeAgent } from "./opencode.js";
import { RovoDevAgent } from "./rovodev.js";
import { GeminiAgent } from "./gemini.js";
import { CopilotAgent } from "./copilot.js";
import { JunieAgent } from "./junie.js";
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
    expect(ClaudeAgent).toHaveBeenCalledWith(undefined);
    expect(agent.name).toBe("claude");
  });

  it("creates a CodexAgent when name is 'codex'", () => {
    const agent = createAgent("codex", stubRunInfo);
    expect(CodexAgent).toHaveBeenCalledWith(stubRunInfo.schemaPath, undefined);
    expect(agent.name).toBe("codex");
  });

  it("creates a RovoDevAgent when name is 'rovodev'", () => {
    const agent = createAgent("rovodev", stubRunInfo);
    expect(RovoDevAgent).toHaveBeenCalledWith(stubRunInfo.schemaPath, {
      bin: undefined,
    });
    expect(agent.name).toBe("rovodev");
  });

  it("creates an OpenCodeAgent when name is 'opencode'", () => {
    const agent = createAgent("opencode", stubRunInfo);
    expect(OpenCodeAgent).toHaveBeenCalledWith({ bin: undefined });
    expect(agent.name).toBe("opencode");
  });

  it("creates a GeminiAgent when name is 'gemini'", () => {
    const agent = createAgent("gemini", stubRunInfo);
    expect(GeminiAgent).toHaveBeenCalledWith({ bin: undefined });
    expect(agent.name).toBe("gemini");
  });

  it("creates a CopilotAgent when name is 'copilot'", () => {
    const agent = createAgent("copilot", stubRunInfo);
    expect(CopilotAgent).toHaveBeenCalledWith({ bin: undefined });
    expect(agent.name).toBe("copilot");
  });

  it("creates a JunieAgent when name is 'junie'", () => {
    const agent = createAgent("junie", stubRunInfo);
    expect(JunieAgent).toHaveBeenCalledWith({ bin: undefined });
    expect(agent.name).toBe("junie");
  });
});
