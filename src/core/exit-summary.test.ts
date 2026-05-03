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

  it("widens the top card for long branch names", () => {
    const summary = stripExitSummaryAnsi(
      renderExitSummary({
        ...baseSummary,
        branchName:
          "gnhf/add-responsive-exit-summary-for-extremely-long-branch-names",
        color: false,
        terminalColumns: 100,
      }),
    );
    const cardLines = summary
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("╭") || line.startsWith("│") || line.startsWith("╰"),
      );
    const cardWidth = cardLines[0]!.length;

    expect(cardWidth).toBeGreaterThan(62);
    expect(cardLines.every((line) => line.length === cardWidth)).toBe(true);
  });

  it("keeps the top card within narrow terminal width", () => {
    const summary = stripExitSummaryAnsi(
      renderExitSummary({
        ...baseSummary,
        branchName:
          "gnhf/add-responsive-exit-summary-for-extremely-long-branch-names",
        color: false,
        terminalColumns: 50,
      }),
    );
    const cardLines = summary
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("╭") || line.startsWith("│") || line.startsWith("╰"),
      );

    expect(cardLines.length).toBe(4);
    expect(cardLines.every((line) => line.length <= 50)).toBe(true);
    expect(
      cardLines.every((line) => line.length === cardLines[0]!.length),
    ).toBe(true);
  });

  it("resets color before the right border when truncating colored content", () => {
    const summary = renderExitSummary({
      ...baseSummary,
      branchName:
        "gnhf/add-responsive-exit-summary-for-extremely-long-branch-names",
      color: true,
      terminalColumns: 50,
    });
    const subtitleLine = summary
      .split("\n")
      .find((line) => line.includes("worked for"));

    expect(subtitleLine).toContain("…\x1b[0m\x1b[2m │");
  });
});
