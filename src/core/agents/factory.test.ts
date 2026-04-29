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

vi.mock("./copilot.js", () => {
  const CopilotAgent = vi.fn(function (
    this: Record<string, unknown>,
    deps?: Record<string, unknown>,
  ) {
    this.name = "copilot";
    this.deps = deps;
  });
  return { CopilotAgent };
});

vi.mock("./pi.js", () => {
  const PiAgent = vi.fn(function (
    this: Record<string, unknown>,
    deps?: Record<string, unknown>,
  ) {
    this.name = "pi";
    this.deps = deps;
  });
  return { PiAgent };
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
import { CopilotAgent } from "./copilot.js";
import { CodexAgent } from "./codex.js";
import { OpenCodeAgent } from "./opencode.js";
import { PiAgent } from "./pi.js";
import { RovoDevAgent } from "./rovodev.js";
import type { RunInfo } from "../run.js";

const stubRunInfo: RunInfo = {
  runId: "test-run",
  runDir: "/repo/.gnhf/runs/test-run",
  promptPath: "/repo/.gnhf/runs/test-run/PROMPT.md",
  notesPath: "/repo/.gnhf/runs/test-run/notes.md",
  schemaPath: "/repo/.gnhf/runs/test-run/schema.json",
  logPath: "/repo/.gnhf/runs/test-run/gnhf.log",
  baseCommit: "abc123",
  baseCommitPath: "/repo/.gnhf/runs/test-run/base-commit",
  stopWhenPath: "/repo/.gnhf/runs/test-run/stop-when",
  stopWhen: undefined,
  commitMessagePath: "/repo/.gnhf/runs/test-run/commit-message",
  commitMessage: undefined,
};

const noStopSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    success: { type: "boolean" },
    summary: { type: "string" },
    key_changes_made: { type: "array", items: { type: "string" } },
    key_learnings: { type: "array", items: { type: "string" } },
  },
  required: ["success", "summary", "key_changes_made", "key_learnings"],
};

const withStopSchema = {
  ...noStopSchema,
  properties: {
    ...noStopSchema.properties,
    should_fully_stop: { type: "boolean" },
  },
  required: [...noStopSchema.required, "should_fully_stop"],
};

describe("createAgent", () => {
  it("creates a ClaudeAgent when name is 'claude'", () => {
    const agent = createAgent("claude", stubRunInfo, undefined, undefined, {
      includeStopField: false,
    });
    expect(ClaudeAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: undefined,
      schema: noStopSchema,
    });
    expect(agent.name).toBe("claude");
  });

  it("passes per-agent extra args through to the ClaudeAgent", () => {
    const agent = createAgent(
      "claude",
      stubRunInfo,
      undefined,
      ["--model", "sonnet"],
      { includeStopField: false },
    );

    expect(ClaudeAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: ["--model", "sonnet"],
      schema: noStopSchema,
    });
    expect(agent.name).toBe("claude");
  });

  it("hands ClaudeAgent a schema that requires should_fully_stop when includeStopField is true", () => {
    createAgent("claude", stubRunInfo, undefined, undefined, {
      includeStopField: true,
    });
    expect(ClaudeAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: undefined,
      schema: withStopSchema,
    });
  });

  it("hands ClaudeAgent a schema with configured commit message fields", () => {
    createAgent("claude", stubRunInfo, undefined, undefined, {
      includeStopField: false,
      commitFields: [
        { name: "type", allowed: ["feat", "fix"] },
        { name: "scope" },
      ],
    });

    expect(ClaudeAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: undefined,
      schema: {
        ...noStopSchema,
        properties: {
          ...noStopSchema.properties,
          type: { type: "string", enum: ["feat", "fix"] },
          scope: { type: "string" },
        },
        required: [...noStopSchema.required, "type", "scope"],
      },
    });
  });

  it("creates a CodexAgent when name is 'codex'", () => {
    const agent = createAgent("codex", stubRunInfo, undefined, undefined, {
      includeStopField: false,
    });
    expect(CodexAgent).toHaveBeenCalledWith(stubRunInfo.schemaPath, {
      bin: undefined,
      extraArgs: undefined,
    });
    expect(agent.name).toBe("codex");
  });

  it("creates a CopilotAgent when name is 'copilot'", () => {
    const agent = createAgent("copilot", stubRunInfo, undefined, undefined, {
      includeStopField: false,
    });
    expect(CopilotAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: undefined,
      schema: noStopSchema,
    });
    expect(agent.name).toBe("copilot");
  });

  it("passes per-agent extra args through to the CopilotAgent", () => {
    const agent = createAgent(
      "copilot",
      stubRunInfo,
      undefined,
      ["--model", "gpt-5.4"],
      { includeStopField: false },
    );

    expect(CopilotAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: ["--model", "gpt-5.4"],
      schema: noStopSchema,
    });
    expect(agent.name).toBe("copilot");
  });

  it("hands CopilotAgent a schema that requires should_fully_stop when includeStopField is true", () => {
    createAgent("copilot", stubRunInfo, undefined, undefined, {
      includeStopField: true,
    });
    expect(CopilotAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: undefined,
      schema: withStopSchema,
    });
  });

  it("passes per-agent extra args through to the CodexAgent", () => {
    const agent = createAgent(
      "codex",
      stubRunInfo,
      undefined,
      ["-m", "gpt-5.4", "--full-auto"],
      { includeStopField: false },
    );

    expect(CodexAgent).toHaveBeenCalledWith(stubRunInfo.schemaPath, {
      bin: undefined,
      extraArgs: ["-m", "gpt-5.4", "--full-auto"],
    });
    expect(agent.name).toBe("codex");
  });

  it("creates a PiAgent when name is 'pi'", () => {
    const agent = createAgent("pi", stubRunInfo, undefined, undefined, {
      includeStopField: false,
    });
    expect(PiAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: undefined,
      schema: noStopSchema,
    });
    expect(agent.name).toBe("pi");
  });

  it("passes path override and extra args through to the PiAgent", () => {
    const agent = createAgent(
      "pi",
      stubRunInfo,
      "/custom/pi",
      ["--provider", "openai-codex", "--model", "gpt-5.5"],
      { includeStopField: false },
    );

    expect(PiAgent).toHaveBeenCalledWith({
      bin: "/custom/pi",
      extraArgs: ["--provider", "openai-codex", "--model", "gpt-5.5"],
      schema: noStopSchema,
    });
    expect(agent.name).toBe("pi");
  });

  it("hands PiAgent a schema that requires should_fully_stop when includeStopField is true", () => {
    createAgent("pi", stubRunInfo, undefined, undefined, {
      includeStopField: true,
    });
    expect(PiAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: undefined,
      schema: withStopSchema,
    });
  });

  it("creates a RovoDevAgent when name is 'rovodev'", () => {
    const agent = createAgent("rovodev", stubRunInfo, undefined, undefined, {
      includeStopField: false,
    });
    expect(RovoDevAgent).toHaveBeenCalledWith(stubRunInfo.schemaPath, {
      bin: undefined,
      extraArgs: undefined,
    });
    expect(agent.name).toBe("rovodev");
  });

  it("passes per-agent extra args through to the RovoDevAgent", () => {
    const agent = createAgent(
      "rovodev",
      stubRunInfo,
      undefined,
      ["--profile", "work"],
      { includeStopField: false },
    );

    expect(RovoDevAgent).toHaveBeenCalledWith(stubRunInfo.schemaPath, {
      bin: undefined,
      extraArgs: ["--profile", "work"],
    });
    expect(agent.name).toBe("rovodev");
  });

  it("creates an OpenCodeAgent when name is 'opencode'", () => {
    const agent = createAgent("opencode", stubRunInfo, undefined, undefined, {
      includeStopField: false,
    });
    expect(OpenCodeAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: undefined,
      schema: noStopSchema,
    });
    expect(agent.name).toBe("opencode");
  });

  it("passes per-agent extra args through to the OpenCodeAgent", () => {
    const agent = createAgent(
      "opencode",
      stubRunInfo,
      undefined,
      ["--model", "gpt-5"],
      { includeStopField: false },
    );

    expect(OpenCodeAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: ["--model", "gpt-5"],
      schema: noStopSchema,
    });
    expect(agent.name).toBe("opencode");
  });

  it("hands OpenCodeAgent a schema that requires should_fully_stop when includeStopField is true", () => {
    createAgent("opencode", stubRunInfo, undefined, undefined, {
      includeStopField: true,
    });
    expect(OpenCodeAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: undefined,
      schema: withStopSchema,
    });
  });
});
