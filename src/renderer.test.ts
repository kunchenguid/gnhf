import { describe, it, expect } from "vitest";
import {
  stripAnsi,
  renderTitle,
  renderStats,
  renderAgentMessage,
  renderMoonStrip,
  renderStarFieldLines,
  buildFrame,
} from "./renderer.js";
import type { OrchestratorState } from "./core/orchestrator.js";

describe("renderTitle", () => {
  it("renders the gnhf eyebrow above the ASCII art", () => {
    const lines = renderTitle().map(stripAnsi);
    const eyebrowIdx = lines.findIndex((l) => l.includes("g n h f"));
    const artIdx = lines.findIndex((l) => l.includes("┏━╸┏━┓"));
    expect(eyebrowIdx).toBeGreaterThanOrEqual(0);
    expect(artIdx).toBeGreaterThan(eyebrowIdx);
  });

  it("renders all three lines of ASCII art", () => {
    const plain = renderTitle().map(stripAnsi).join("\n");
    expect(plain).toContain("┏━╸┏━┓┏━┓╺┳┓");
    expect(plain).toContain("┃╺┓┃ ┃┃ ┃ ┃┃");
    expect(plain).toContain("┗━┛┗━┛┗━┛╺┻┛");
  });
});

describe("renderStats", () => {
  it("renders elapsed, input tokens, output tokens, and commits", () => {
    const line = stripAnsi(renderStats("01:23:45", 12400, 8200, 12));
    expect(line).toContain("01:23:45");
    expect(line).toContain("12K");
    expect(line).toContain("8K");
    expect(line).toContain("12 commits");
  });

  it("does not contain iteration", () => {
    const line = stripAnsi(renderStats("00:00:00", 0, 0, 0));
    expect(line).not.toContain("iteration");
  });
});

describe("renderAgentMessage", () => {
  it("shows working indicator when no message", () => {
    const plain = renderAgentMessage(null, "running").map(stripAnsi).join("\n");
    expect(plain).toContain("working...");
  });

  it("shows waiting status during backoff", () => {
    const plain = renderAgentMessage(null, "waiting").map(stripAnsi).join("\n");
    expect(plain).toContain("waiting");
  });

  it("renders a short message on one line", () => {
    const plain = renderAgentMessage("Reading file...", "running")
      .map(stripAnsi)
      .join("\n");
    expect(plain).toContain("Reading file...");
  });

  it("truncates messages longer than 3 lines with ellipsis", () => {
    const longMsg =
      "Line one of the message\nLine two of the message\nLine three of the message\nLine four should be cut";
    const plain = renderAgentMessage(longMsg, "running")
      .map(stripAnsi)
      .join("\n");
    expect(plain).toContain("Line one");
    expect(plain).toContain("Line two");
    expect(plain).toContain("\u2026");
    expect(plain).not.toContain("Line four");
  });
});

describe("renderMoonStrip", () => {
  it("renders full moons for successes and new moons for failures", () => {
    const iterations = [
      { success: true },
      { success: true },
      { success: false },
    ];
    const text = renderMoonStrip(iterations, false, Date.now()).join("");
    expect(text).toContain("\u{1F315}\u{1F315}\u{1F311}");
  });

  it("shows an animated moon when running", () => {
    const iterations = [{ success: true }];
    const text = renderMoonStrip(iterations, true, Date.now()).join("");
    expect(text).toContain("\u{1F315}");
    expect(text).toMatch(
      /[\u{1F311}\u{1F312}\u{1F313}\u{1F314}\u{1F315}\u{1F316}\u{1F317}\u{1F318}]/u,
    );
  });

  it("renders empty when no iterations and not running", () => {
    const text = renderMoonStrip([], false, Date.now()).join("");
    expect(text.trim()).toBe("");
  });

  it("shows only active moon when running with no completed iterations", () => {
    const text = renderMoonStrip([], true, Date.now()).join("");
    expect(text).toMatch(
      /[\u{1F311}\u{1F312}\u{1F313}\u{1F314}\u{1F315}\u{1F316}\u{1F317}\u{1F318}]/u,
    );
  });
});

describe("renderStarFieldLines", () => {
  it("renders the correct number of rows", () => {
    const lines = renderStarFieldLines(42, 40, 3, Date.now());
    expect(lines).toHaveLength(3);
  });

  it("contains star characters", () => {
    const text = renderStarFieldLines(42, 80, 5, Date.now())
      .map(stripAnsi)
      .join("\n");
    expect(/[·✧⋆°]/.test(text)).toBe(true);
  });
});

describe("buildFrame", () => {
  const stripCursorHome = (frame: string) =>
    frame.startsWith("\x1b[H") ? frame.slice(3) : frame;

  it("shows the stop and resume hint on the second-to-last row with blank bottom padding", () => {
    const state: OrchestratorState = {
      status: "running",
      currentIteration: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      commitCount: 0,
      iterations: [],
      successCount: 0,
      failCount: 0,
      consecutiveFailures: 0,
      startTime: new Date("2026-01-01T00:00:00Z"),
      waitingUntil: null,
      lastMessage: null,
    };

    const frame = buildFrame("ship it", state, [], [], [], Date.now(), 80, 30);
    const lines = stripCursorHome(frame).split("\n");
    const rawHintLine = lines.at(-2) ?? "";
    const hintLine = stripAnsi(rawHintLine);

    expect(hintLine.trim()).toBe("[ctrl+c to stop, gnhf again to resume]");
    expect(rawHintLine).toContain("\x1b[2m");
    expect(stripAnsi(lines.at(-1) ?? "").trim()).toBe("");

    const leftPad = hintLine.indexOf("[");
    const rightPad = hintLine.length - leftPad - hintLine.trim().length;
    expect(Math.abs(leftPad - rightPad)).toBeLessThanOrEqual(1);
  });

  it("keeps all moon rows visible on tight terminals by reserving a real footer row", () => {
    const state: OrchestratorState = {
      status: "done",
      currentIteration: 61,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      commitCount: 0,
      iterations: Array.from({ length: 61 }, (_, index) => ({
        iteration: index + 1,
        success: true,
      })),
      successCount: 61,
      failCount: 0,
      consecutiveFailures: 0,
      startTime: new Date("2026-01-01T00:00:00Z"),
      waitingUntil: null,
      lastMessage: null,
    };

    const frame = buildFrame("ship it", state, [], [], [], Date.now(), 80, 24);
    const lines = stripCursorHome(frame).split("\n");
    const plainLines = lines.map(stripAnsi);
    const moonLines = plainLines.filter((line) => /🌕/.test(line));

    expect(lines).toHaveLength(24);
    expect(moonLines).toHaveLength(3);
    expect(plainLines.at(-2)?.trim()).toBe(
      "[ctrl+c to stop, gnhf again to resume]",
    );
    expect(plainLines.at(-1)?.trim()).toBe("");
  });
});
