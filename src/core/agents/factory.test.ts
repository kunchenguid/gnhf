import { describe, it, expect, vi } from "vitest";

vi.mock("./claude.js", () => {
  const ClaudeAgent = vi.fn(function (
    this: Record<string, unknown>,
    deps?: Record<string, unknown>,
  ) {
    this.name = "claude";
    this.deps = deps;
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
    deps?: Record<string, unknown>,
  ) {
    this.name = "rovodev";
    this.schemaPath = schemaPath;
    this.deps = deps;
  });
  return { RovoDevAgent };
});

vi.mock("./opencode.js", () => {
  const OpenCodeAgent = vi.fn(function (
    this: Record<string, unknown>,
    deps?: Record<string, unknown>,
  ) {
    this.name = "opencode";
    this.deps = deps;
  });
  return { OpenCodeAgent };
});

import { createAgent } from "./factory.js";
import { ClaudeAgent } from "./claude.js";
import { CodexAgent } from "./codex.js";
import { OpenCodeAgent } from "./opencode.js";
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
    expect(ClaudeAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: undefined,
    });
    expect(agent.name).toBe("claude");
  });

  it("passes per-agent extra args through to the ClaudeAgent", () => {
    const agent = createAgent("claude", stubRunInfo, undefined, [
      "--model",
      "sonnet",
    ]);

    expect(ClaudeAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: ["--model", "sonnet"],
    });
    expect(agent.name).toBe("claude");
  });

  it("creates a CodexAgent when name is 'codex'", () => {
    const agent = createAgent("codex", stubRunInfo);
    expect(CodexAgent).toHaveBeenCalledWith(stubRunInfo.schemaPath, {
      bin: undefined,
      extraArgs: undefined,
    });
    expect(agent.name).toBe("codex");
  });

  it("passes per-agent extra args through to the CodexAgent", () => {
    const agent = createAgent("codex", stubRunInfo, undefined, [
      "-m",
      "gpt-5.4",
      "--full-auto",
    ]);

    expect(CodexAgent).toHaveBeenCalledWith(stubRunInfo.schemaPath, {
      bin: undefined,
      extraArgs: ["-m", "gpt-5.4", "--full-auto"],
    });
    expect(agent.name).toBe("codex");
  });

  it("creates a RovoDevAgent when name is 'rovodev'", () => {
    const agent = createAgent("rovodev", stubRunInfo);
    expect(RovoDevAgent).toHaveBeenCalledWith(stubRunInfo.schemaPath, {
      bin: undefined,
      extraArgs: undefined,
    });
    expect(agent.name).toBe("rovodev");
  });

  it("passes per-agent extra args through to the RovoDevAgent", () => {
    const agent = createAgent("rovodev", stubRunInfo, undefined, [
      "--profile",
      "work",
    ]);

    expect(RovoDevAgent).toHaveBeenCalledWith(stubRunInfo.schemaPath, {
      bin: undefined,
      extraArgs: ["--profile", "work"],
    });
    expect(agent.name).toBe("rovodev");
  });

  it("creates an OpenCodeAgent when name is 'opencode'", () => {
    const agent = createAgent("opencode", stubRunInfo);
    expect(OpenCodeAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: undefined,
    });
    expect(agent.name).toBe("opencode");
  });

  it("passes per-agent extra args through to the OpenCodeAgent", () => {
    const agent = createAgent("opencode", stubRunInfo, undefined, [
      "--model",
      "gpt-5",
    ]);

    expect(OpenCodeAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: ["--model", "gpt-5"],
    });
    expect(agent.name).toBe("opencode");
  });
});
