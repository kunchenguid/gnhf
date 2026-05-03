import { describe, expect, it } from "vitest";
import { renderExitSummary, stripExitSummaryAnsi } from "./exit-summary.js";

const baseSummary = {
  agentName: "opencode",
  branchName: "gnhf/refactor-auth-flow",
  elapsedMs: 47 * 60_000 + 12_000,
  status: "stopped" as const,
  iterations: 8,
  successCount: 6,
  failCount: 2,
  totalInputTokens: 12_400_000,
  totalOutputTokens: 96_100,
  tokensEstimated: false,
  commitCount: 6,
  notesPath: ".gnhf/runs/refactor-auth-flow/notes.md",
  logPath: ".gnhf/runs/refactor-auth-flow/gnhf.log",
  baseRef: "main",
  diffStats: {
    commits: 6,
    filesChanged: 18,
    filesAdded: 7,
    filesUpdated: 9,
    filesDeleted: 2,
    filesRenamed: 0,
    binaryFiles: 0,
    linesAdded: 1284,
    linesDeleted: 412,
  },
};

describe("renderExitSummary", () => {
  it("renders the recommended stdout summary without a moon log", () => {
    const summary = stripExitSummaryAnsi(
      renderExitSummary({ ...baseSummary, color: false }),
    );

    expect(summary).toContain("✦ gnhf wrapped");
    expect(summary).toContain(
      "opencode worked for 47m 12s on gnhf/refactor-auth-flow",
    );
    expect(summary).toContain(
      "iterations      8 total       6 good       2 rolled back",
    );
    expect(summary).toContain("tokens          12.4M in      96K out");
    expect(summary).toContain(
      "branch diff     6 commits     +1,284       -412",
    );
    expect(summary).toContain(
      "files           7 added       9 updated    2 deleted",
    );
    expect(summary).toContain("next steps      git log --oneline main..HEAD");
    expect(summary).toContain("too much?       git push no-mistakes:");
    expect(summary).toContain("https://github.com/kunchenguid/no-mistakes");
    expect(summary).not.toContain("moon log");
  });

  it("marks estimated token totals with a tilde", () => {
    const summary = stripExitSummaryAnsi(
      renderExitSummary({
        ...baseSummary,
        tokensEstimated: true,
        color: false,
      }),
    );

    expect(summary).toContain("tokens          ~12.4M in     ~96K out");
  });

  it("uses a stopped header for aborted runs", () => {
    const summary = stripExitSummaryAnsi(
      renderExitSummary({
        ...baseSummary,
        status: "aborted",
        abortReason: "3 consecutive failures",
        color: false,
      }),
    );

    expect(summary).toContain("× gnhf stopped");
    expect(summary).toContain(
      "opencode ran for 47m 12s before: 3 consecutive failures",
    );
  });

  it("adds ANSI color when requested", () => {
    const summary = renderExitSummary({ ...baseSummary, color: true });

    expect(summary).toContain("\x1b[");
    expect(stripExitSummaryAnsi(summary)).not.toContain("\x1b[");
  });
});
