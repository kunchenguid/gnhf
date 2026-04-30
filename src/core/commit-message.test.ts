import { describe, expect, it } from "vitest";
import { buildCommitMessage } from "./commit-message.js";
import type { AgentOutput } from "./agents/types.js";

type CommitMessageTestOutput = AgentOutput & {
  type?: unknown;
  scope?: unknown;
};

function commitMessageOutput(output: CommitMessageTestOutput): AgentOutput {
  return output;
}

describe("buildCommitMessage", () => {
  it("renders the pre-existing gnhf commit subject when config is omitted", () => {
    const message = buildCommitMessage(
      undefined,
      {
        success: true,
        summary: "add retry coverage",
        key_changes_made: [],
        key_learnings: [],
      },
      { iteration: 3 },
    );

    expect(message).toBe("gnhf #3: add retry coverage");
  });

  it("renders a Conventional Commits header with a scope", () => {
    const message = buildCommitMessage(
      { preset: "conventional" },
      commitMessageOutput({
        success: true,
        summary: "handle empty output",
        key_changes_made: [],
        key_learnings: [],
        type: "fix",
        scope: "core",
      }),
      { iteration: 1 },
    );

    expect(message).toBe("fix(core): handle empty output");
  });

  it("renders a Conventional Commits header without a scope", () => {
    const message = buildCommitMessage(
      { preset: "conventional" },
      commitMessageOutput({
        success: true,
        summary: "refresh docs",
        key_changes_made: [],
        key_learnings: [],
        type: "docs",
        scope: "",
      }),
      { iteration: 1 },
    );

    expect(message).toBe("docs: refresh docs");
  });

  it("falls back to configured field defaults when output omits them", () => {
    const message = buildCommitMessage(
      { preset: "conventional" },
      {
        success: true,
        summary: "tidy internal naming",
        key_changes_made: [],
        key_learnings: [],
      },
      { iteration: 2 },
    );

    expect(message).toBe("chore: tidy internal naming");
  });

  it("falls back to the default Conventional Commits type when output provides an invalid type", () => {
    const message = buildCommitMessage(
      { preset: "conventional" },
      commitMessageOutput({
        success: true,
        summary: "tidy internal naming",
        key_changes_made: [],
        key_learnings: [],
        type: "wip",
      }),
      { iteration: 2 },
    );

    expect(message).toBe("chore: tidy internal naming");
  });

  it("collapses newlines in rendered headers", () => {
    const message = buildCommitMessage(
      { preset: "conventional" },
      commitMessageOutput({
        success: true,
        summary: "add parser\nwith extra spacing",
        key_changes_made: [],
        key_learnings: [],
        type: "feat",
      }),
      { iteration: 4 },
    );

    expect(message).toBe("feat: add parser with extra spacing");
  });
});
