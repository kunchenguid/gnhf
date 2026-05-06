import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import * as renderer from "./renderer.js";
import {
  Renderer,
  stripAnsi,
  renderTitle,
  renderStats,
  renderAgentMessage,
  renderMoonStrip,
  renderStarFieldLines,
  buildFrame,
  buildFrameCells,
  buildContentCells,
} from "./renderer.js";
import { rowToString } from "./renderer-diff.js";
import type {
  IterationRecord,
  Orchestrator,
  OrchestratorState,
} from "./core/orchestrator.js";

function createIteration(
  overrides: Partial<IterationRecord> = {},
): IterationRecord {
  return {
    number: 1,
    success: true,
    summary: "done",
    keyChanges: [],
    keyLearnings: [],
    timestamp: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("renderTitle", () => {
  it("renders the gnhf eyebrow above the ASCII art", () => {
    const lines = renderTitle().map(stripAnsi);
    const eyebrowIdx = lines.findIndex((l) => l.includes("g n h f"));
    const artIdx = lines.findIndex((l) => l.includes("┏━╸┏━┓"));
    expect(eyebrowIdx).toBeGreaterThanOrEqual(0);
    expect(artIdx).toBeGreaterThan(eyebrowIdx);
  });

  it("renders the agent name in the eyebrow", () => {
    const lines = renderTitle("rovodev").map(stripAnsi);
    expect(lines[0]).toContain("g n h f");
    expect(lines[0]).toContain("·");
    expect(lines[0]).toContain("r o v o d e v");
  });

  it("renders an acp:<target> spec as two dot-separated segments", () => {
    const lines = renderTitle("acp:claude").map(stripAnsi);
    expect(lines[0]).toContain("g n h f  ·  a c p  ·  c l a u d e");
    // The colon should not appear as a letter-spaced character.
    expect(lines[0]).not.toContain("a c p :");
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

  it("prefixes token counts with '~' when usage is estimated", () => {
    const plain = stripAnsi(renderStats("01:23:45", 12400, 8200, 12, true));
    expect(plain).toContain("~12K in");
    expect(plain).toContain("~8K out");
    // The '~' prefix is informational only - commit count is concrete and
    // should not be prefixed.
    expect(plain).not.toContain("~12 commits");
  });

  it("does not prefix tokens when usage is authoritative", () => {
    const plain = stripAnsi(renderStats("01:23:45", 12400, 8200, 12, false));
    expect(plain).not.toContain("~");
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

  it("shows the last agent error while waiting during backoff", () => {
    const plain = renderAgentMessage(
      "previous agent output",
      "waiting",
      "claude exited with code 1: Credit balance is too low",
    )
      .map(stripAnsi)
      .join("\n");

    expect(plain).toContain("waiting");
    expect(plain).toContain("Credit balance is too low");
    expect(plain).not.toContain("previous agent output");
  });

  it("shows the abort reason and last agent error after abort", () => {
    const plain = renderAgentMessage(
      "3 consecutive failures",
      "aborted",
      "claude exited with code 1: Credit balance is too low",
    )
      .map(stripAnsi)
      .join("\n");

    expect(plain).toContain("3 consecutive failures");
    expect(plain).toContain("Credit balance is too low");
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

  it("keeps a trailing wide glyph intact at the message width boundary", () => {
    expect(
      renderAgentMessage(`${"A".repeat(62)}🌕`, "running")
        .map(stripAnsi)
        .filter(Boolean),
    ).toEqual(["A".repeat(62), "🌕"]);
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

  it("adds a sparse meteor streak without overwhelming the star field", () => {
    const text = renderStarFieldLines(42, 80, 8, 0).map(stripAnsi).join("\n");
    const meteorCells = text.match(/╱/g)?.length ?? 0;

    expect(meteorCells).toBeGreaterThan(0);
    expect(meteorCells).toBeLessThanOrEqual(4);
  });

  it("disables meteors when frequency is zero", () => {
    const text = renderStarFieldLines(42, 80, 8, 0, 0)
      .map(stripAnsi)
      .join("\n");

    expect(text).not.toContain("╱");
  });

  it("increases meteor streaks when frequency is raised", () => {
    const countCells = (frequency: number): number =>
      [0, 500, 1000, 1500]
        .map((now) =>
          renderStarFieldLines(42, 80, 8, now, frequency)
            .map(stripAnsi)
            .join("\n"),
        )
        .reduce((total, text) => total + (text.match(/╱/g)?.length ?? 0), 0);
    const quietCells = countCells(1);
    const busyCells = countCells(3);

    expect(busyCells).toBeGreaterThan(quietCells);
  });

  it("makes frequency 5 roughly twice as frequent as frequency 3", () => {
    const countCells = (frequency: number): number =>
      [
        0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500,
        6000, 6500, 7000, 7500, 8000,
      ]
        .map((now) =>
          renderStarFieldLines(42, 120, 12, now, frequency)
            .map(stripAnsi)
            .join("\n"),
        )
        .reduce((total, text) => total + (text.match(/╱/g)?.length ?? 0), 0);
    const mediumCells = countCells(3);
    const highCells = countCells(5);

    expect(highCells).toBeGreaterThanOrEqual(mediumCells * 2);
  });

  it("does not render meteor head glyphs", () => {
    const text = renderStarFieldLines(42, 120, 12, 0, 5)
      .map(stripAnsi)
      .join("\n");

    expect(text).not.toContain("✦");
  });
});

describe("buildFrame", () => {
  const stripCursorHome = (frame: string) =>
    frame.startsWith("\x1b[H") ? frame.slice(3) : frame;

  it("wraps a trailing wide prompt glyph onto the next line instead of dropping it", () => {
    const state: OrchestratorState = {
      status: "running",
      gracefulStopRequested: false,
      interruptHint: "resume",
      currentIteration: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      tokensEstimated: false,
      commitCount: 0,
      iterations: [],
      successCount: 0,
      failCount: 0,
      consecutiveFailures: 0,
      consecutiveErrors: 0,
      startTime: new Date("2026-01-01T00:00:00Z"),
      waitingUntil: null,
      lastMessage: null,
    };

    const lines = renderer
      .buildContentLines(
        `${"A".repeat(62)}🌕`,
        "claude",
        state,
        "00:00:00",
        Date.now(),
      )
      .map(stripAnsi);

    expect(lines.slice(8, 11).filter(Boolean)).toEqual(["A".repeat(62), "🌕"]);
  });

  it("shows the stop and resume hint on the second-to-last row with blank bottom padding", () => {
    const state: OrchestratorState = {
      status: "running",
      gracefulStopRequested: false,
      interruptHint: "resume",
      currentIteration: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      tokensEstimated: false,
      commitCount: 0,
      iterations: [],
      successCount: 0,
      failCount: 0,
      consecutiveFailures: 0,
      consecutiveErrors: 0,
      startTime: new Date("2026-01-01T00:00:00Z"),
      waitingUntil: null,
      lastMessage: null,
    };

    const frame = buildFrame(
      "ship it",
      "claude",
      state,
      [],
      [],
      [],
      Date.now(),
      80,
      30,
    );
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

  it("shows the graceful stop hint after ctrl+c is requested once", () => {
    const state: OrchestratorState = {
      status: "running",
      gracefulStopRequested: true,
      interruptHint: "force-stop",
      currentIteration: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      tokensEstimated: false,
      commitCount: 0,
      iterations: [],
      successCount: 0,
      failCount: 0,
      consecutiveFailures: 0,
      consecutiveErrors: 0,
      startTime: new Date("2026-01-01T00:00:00Z"),
      waitingUntil: null,
      lastMessage: null,
    };

    const frame = buildFrame(
      "ship it",
      "claude",
      state,
      [],
      [],
      [],
      Date.now(),
      120,
      30,
    );
    const lines = stripCursorHome(frame).split("\n");

    expect(stripAnsi(lines.at(-2) ?? "").trim()).toBe(
      "[graceful stop requested, ctrl+c again to force stop, gnhf again to resume]",
    );
  });

  it("keeps all moon rows visible on tight terminals by reserving a real footer row", () => {
    const state: OrchestratorState = {
      status: "stopped",
      gracefulStopRequested: false,
      interruptHint: "force-stop",
      currentIteration: 61,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      tokensEstimated: false,
      commitCount: 0,
      iterations: Array.from({ length: 61 }, (_, index) =>
        createIteration({ number: index + 1, success: true }),
      ),
      successCount: 61,
      failCount: 0,
      consecutiveFailures: 0,
      consecutiveErrors: 0,
      startTime: new Date("2026-01-01T00:00:00Z"),
      waitingUntil: null,
      lastMessage: null,
    };

    const frame = buildFrame(
      "ship it",
      "claude",
      state,
      [],
      [],
      [],
      Date.now(),
      80,
      24,
    );
    const lines = stripCursorHome(frame).split("\n");
    const plainLines = lines.map(stripAnsi);
    const moonLines = plainLines.filter((line) => /🌕/.test(line));

    expect(lines).toHaveLength(24);
    expect(moonLines).toHaveLength(3);
    expect(plainLines.at(-2)?.trim()).toBe(
      "[graceful stop requested, ctrl+c again to force stop, gnhf again to resume]",
    );
    expect(plainLines.at(-1)?.trim()).toBe("");
  });

  it("does not let wide agent text push side stars out of position", () => {
    // Use width where (width - CONTENT_WIDTH) is even so sideWidth*2 + 63 = width
    const terminalWidth = 83;
    const terminalHeight = 30;
    // Message that overflows CONTENT_WIDTH only because the trailing glyph is 2 cells wide.
    const longMessage = `${"A".repeat(62)}🌕`;

    const state: OrchestratorState = {
      status: "running",
      gracefulStopRequested: false,
      interruptHint: "resume",
      currentIteration: 1,
      totalInputTokens: 500,
      totalOutputTokens: 300,
      tokensEstimated: false,
      commitCount: 0,
      iterations: [],
      successCount: 0,
      failCount: 0,
      consecutiveFailures: 0,
      consecutiveErrors: 0,
      startTime: new Date("2026-01-01T00:00:00Z"),
      waitingUntil: null,
      lastMessage: longMessage,
    };

    const cells = buildFrameCells(
      "ship it",
      "claude",
      state,
      [],
      [],
      [],
      Date.now(),
      terminalWidth,
      terminalHeight,
    );

    // Every row must be exactly terminalWidth — a wider agent message row
    // would push the right-side stars out of alignment.
    for (let r = 0; r < cells.length; r++) {
      expect(cells[r]).toHaveLength(terminalWidth);
    }
  });

  it("keeps stats visible when moon rows exceed the content viewport", () => {
    const state: OrchestratorState = {
      status: "stopped",
      gracefulStopRequested: false,
      interruptHint: "force-stop",
      currentIteration: 660,
      totalInputTokens: 1200,
      totalOutputTokens: 800,
      tokensEstimated: false,
      commitCount: 7,
      iterations: Array.from({ length: 660 }, (_, index) =>
        createIteration({ number: index + 1, success: true }),
      ),
      successCount: 660,
      failCount: 0,
      consecutiveFailures: 0,
      consecutiveErrors: 0,
      startTime: new Date("2026-01-01T00:00:00Z"),
      waitingUntil: null,
      lastMessage: null,
    };

    const frame = buildFrame(
      "ship it",
      "claude",
      state,
      [],
      [],
      [],
      Date.now(),
      80,
      24,
    );
    const plainLines = stripCursorHome(frame).split("\n").map(stripAnsi);

    expect(plainLines.join("\n")).toContain("7 commits");
    expect(plainLines.join("\n")).toContain("1K in");
    expect(plainLines.join("\n")).toContain("800 out");
  });

  it("uses the content builder height policy for the content viewport", () => {
    const state: OrchestratorState = {
      status: "running",
      gracefulStopRequested: false,
      interruptHint: "resume",
      currentIteration: 1,
      totalInputTokens: 100,
      totalOutputTokens: 50,
      tokensEstimated: false,
      commitCount: 1,
      iterations: [createIteration()],
      successCount: 1,
      failCount: 0,
      consecutiveFailures: 0,
      consecutiveErrors: 0,
      startTime: new Date("2026-01-01T00:00:00Z"),
      waitingUntil: null,
      lastMessage: "reading files",
    };

    const availableHeight = 22;
    const now = state.startTime.getTime() + 60_000;
    const contentRows = buildContentCells(
      "my prompt",
      "claude",
      state,
      "00:01:00",
      now,
      availableHeight,
    )
      .map(rowToString)
      .map(stripAnsi);
    const frame = buildFrame(
      "my prompt",
      "claude",
      state,
      [],
      [],
      [],
      now,
      63,
      availableHeight + 2,
    );
    const frameLines = stripCursorHome(frame).split("\n").map(stripAnsi);

    expect(
      frameLines.slice(0, availableHeight).map((line) => line.trim()),
    ).toEqual(contentRows);
  });

  it("renders quiet meteor streaks in background rows without changing row widths", () => {
    const state: OrchestratorState = {
      status: "running",
      gracefulStopRequested: false,
      interruptHint: "resume",
      currentIteration: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      tokensEstimated: false,
      commitCount: 0,
      iterations: [],
      successCount: 0,
      failCount: 0,
      consecutiveFailures: 0,
      consecutiveErrors: 0,
      startTime: new Date("2026-01-01T00:00:00Z"),
      waitingUntil: null,
      lastMessage: null,
    };
    const meteors = [
      {
        x: 10,
        y: 3,
        length: 4,
        period: 10_000,
        duration: 1_000,
        phase: 0,
      },
    ];

    const cells = buildFrameCells(
      "ship it",
      "claude",
      state,
      [],
      [],
      [],
      0,
      83,
      36,
      meteors,
      [],
      [],
    );
    const text = cells.map(rowToString).map(stripAnsi).join("\n");
    const meteorCells = text.match(/╱/g)?.length ?? 0;

    expect(meteorCells).toBe(4);
    for (const row of cells) {
      expect(row).toHaveLength(83);
    }
  });

  it("does not start bottom meteors below the top three quarters of the screen", () => {
    const state: OrchestratorState = {
      status: "running",
      gracefulStopRequested: false,
      interruptHint: "resume",
      currentIteration: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      tokensEstimated: false,
      commitCount: 0,
      iterations: [],
      successCount: 0,
      failCount: 0,
      consecutiveFailures: 0,
      consecutiveErrors: 0,
      startTime: new Date("2026-01-01T00:00:00Z"),
      waitingUntil: null,
      lastMessage: null,
    };
    const bottomMeteors = [
      {
        x: 10,
        y: 2,
        length: 3,
        period: 10_000,
        duration: 1_000,
        phase: 0,
      },
    ];

    const cells = buildFrameCells(
      "ship it",
      "claude",
      state,
      [],
      [],
      [],
      0,
      83,
      40,
      [],
      bottomMeteors,
      [],
    );
    const text = cells.map(rowToString).map(stripAnsi).join("\n");

    expect(text).not.toContain("╱");
  });
});

describe("renderer module exports", () => {
  it("does not expose clampCellsToWidth", () => {
    expect("clampCellsToWidth" in renderer).toBe(false);
  });
});

describe("buildContentCells adaptive height", () => {
  const state: OrchestratorState = {
    status: "running",
    gracefulStopRequested: false,
    interruptHint: "resume",
    currentIteration: 1,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    tokensEstimated: false,
    commitCount: 1,
    iterations: [createIteration()],
    successCount: 1,
    failCount: 0,
    consecutiveFailures: 0,
    consecutiveErrors: 0,
    startTime: new Date("2026-01-01T00:00:00Z"),
    waitingUntil: null,
    lastMessage: "reading files",
  };

  const toText = (rows: ReturnType<typeof buildContentCells>): string =>
    rows.map(rowToString).map(stripAnsi).join("\n");

  it("includes all sections at full height", () => {
    const rows = buildContentCells("my prompt", "claude", state, "00:01:00", 0);
    const text = toText(rows);
    expect(text).toContain("┏━╸┏━┓");
    expect(text).toContain("g n h f");
    expect(text).toContain("my prompt");
    expect(text).toContain("reading files");
    expect(text).toContain("00:01:00");
    expect(rows).toHaveLength(22);
  });

  it("keeps the logo separated from both the eyebrow and prompt", () => {
    const lines = buildContentCells("my prompt", "claude", state, "00:01:00", 0)
      .map(rowToString)
      .map(stripAnsi);

    const eyebrowIndex = lines.findIndex((line) => line.includes("g n h f"));
    const firstArtIndex = lines.findIndex((line) => line.includes("┏━╸┏━┓"));
    const lastArtIndex = lines.findIndex((line) => line.includes("┗━┛┗━┛"));
    const promptIndex = lines.findIndex((line) => line.includes("my prompt"));

    expect(firstArtIndex - eyebrowIndex).toBe(3);
    expect(promptIndex - lastArtIndex).toBe(2);
  });

  it("hides ASCII art first when height is insufficient", () => {
    const rows = buildContentCells(
      "my prompt",
      "claude",
      state,
      "00:01:00",
      0,
      21,
    );
    const text = toText(rows);
    expect(text).not.toContain("┏━╸┏━┓");
    expect(text).toContain("g n h f");
    expect(text).toContain("my prompt");
    expect(text).toContain("reading files");
    expect(rows.length).toBeLessThanOrEqual(21);
  });

  it("hides eyebrow after ASCII art", () => {
    const rows = buildContentCells(
      "my prompt",
      "claude",
      state,
      "00:01:00",
      0,
      17,
    );
    const text = toText(rows);
    expect(text).not.toContain("┏━╸┏━┓");
    expect(text).not.toContain("g n h f");
    expect(text).toContain("my prompt");
    expect(text).toContain("reading files");
    expect(rows.length).toBeLessThanOrEqual(17);
  });

  it("hides agent text after eyebrow", () => {
    const rows = buildContentCells(
      "my prompt",
      "claude",
      state,
      "00:01:00",
      0,
      14,
    );
    const text = toText(rows);
    expect(text).not.toContain("┏━╸┏━┓");
    expect(text).not.toContain("g n h f");
    expect(text).not.toContain("reading files");
    expect(text).toContain("my prompt");
    expect(text).toContain("00:01:00");
    expect(rows.length).toBeLessThanOrEqual(14);
  });

  it("hides prompt text last", () => {
    const rows = buildContentCells(
      "my prompt",
      "claude",
      state,
      "00:01:00",
      0,
      9,
    );
    const text = toText(rows);
    expect(text).not.toContain("┏━╸┏━┓");
    expect(text).not.toContain("g n h f");
    expect(text).not.toContain("reading files");
    expect(text).not.toContain("my prompt");
    expect(text).toContain("00:01:00");
    expect(rows.length).toBeLessThanOrEqual(9);
  });

  it("always keeps stats and moon strip even at minimum height", () => {
    const rows = buildContentCells(
      "my prompt",
      "claude",
      state,
      "00:01:00",
      0,
      5,
    );
    const text = toText(rows);
    expect(text).toContain("00:01:00");
    expect(text).toMatch(/🌕/);
    expect(rows.length).toBeLessThanOrEqual(5);
  });

  it("keeps stats visible when moon rows alone exceed the available height", () => {
    const rows = buildContentCells(
      "my prompt",
      "claude",
      {
        ...state,
        status: "stopped",
        iterations: Array.from({ length: 660 }, (_, index) =>
          createIteration({ number: index + 1, success: true }),
        ),
      },
      "00:01:00",
      0,
      22,
    );
    const text = toText(rows);

    expect(text).toContain("00:01:00");
    expect(rows.length).toBeLessThanOrEqual(22);
  });

  it("drops all moon rows when no moon rows fit", () => {
    const rows = buildContentCells(
      "my prompt",
      "claude",
      {
        ...state,
        status: "stopped",
        iterations: Array.from({ length: 660 }, (_, index) =>
          createIteration({ number: index + 1, success: true }),
        ),
      },
      "00:01:00",
      0,
      1,
    );
    const text = toText(rows);

    expect(rows).toHaveLength(1);
    expect(text).toContain("00:01:00");
    expect(text).not.toMatch(/🌕/);
  });
});

describe("Renderer ctrl+c", () => {
  async function runRendererCtrlCTest(state: OrchestratorState): Promise<{
    onInterrupt: ReturnType<typeof vi.fn>;
    orchestratorStop: ReturnType<typeof vi.fn>;
    pause: typeof process.stdin.pause;
    renderer: Renderer;
  }> {
    vi.useFakeTimers();
    let dataHandler: ((data: Buffer) => void) | null = null;
    const onInterrupt = vi.fn();
    const orchestratorStop = vi.fn();
    const orchestrator = Object.assign(new EventEmitter(), {
      getState: vi.fn(() => state),
      stop: orchestratorStop,
      requestGracefulStop: vi.fn(),
    }) as unknown as Orchestrator;

    const originalIsTTY = process.stdin.isTTY;
    const originalSetRawMode = (
      process.stdin as NodeJS.ReadStream & {
        setRawMode?: (mode: boolean) => void;
      }
    ).setRawMode;
    const originalResume = process.stdin.resume;
    const originalPause = process.stdin.pause;
    const originalOn = process.stdin.on;
    const originalRemoveAllListeners = process.stdin.removeAllListeners;
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    const setRawModeMock = vi.fn((mode: boolean) => {
      void mode;
      return process.stdin;
    });
    Object.defineProperty(process.stdin, "setRawMode", {
      configurable: true,
      value: setRawModeMock,
    });
    process.stdin.resume = vi.fn();
    process.stdin.pause = vi.fn();
    process.stdin.on = vi.fn(
      (event: string, handler: (...args: unknown[]) => void) => {
        if (event === "data") {
          dataHandler = handler as (data: Buffer) => void;
        }
        return process.stdin;
      },
    ) as typeof process.stdin.on;
    process.stdin.removeAllListeners = vi.fn(() => process.stdin);

    const renderer = new Renderer(
      orchestrator,
      "ship it",
      "claude",
      onInterrupt,
    );

    try {
      renderer.start();

      expect(dataHandler).not.toBeNull();
      if (!dataHandler) {
        throw new Error("expected renderer to register a data handler");
      }
      (dataHandler as unknown as (data: Buffer) => void)(Buffer.from([3]));

      return {
        onInterrupt,
        orchestratorStop,
        pause: process.stdin.pause,
        renderer,
      };
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: originalIsTTY,
      });
      Object.defineProperty(process.stdin, "setRawMode", {
        configurable: true,
        value: originalSetRawMode,
      });
      process.stdin.resume = originalResume;
      process.stdin.pause = originalPause;
      process.stdin.on = originalOn;
      process.stdin.removeAllListeners = originalRemoveAllListeners;
      stdoutWrite.mockRestore();
      vi.useRealTimers();
    }
  }

  it("delegates ctrl+c handling to the callback", async () => {
    const state: OrchestratorState = {
      status: "running",
      gracefulStopRequested: false,
      interruptHint: "resume",
      currentIteration: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      tokensEstimated: false,
      commitCount: 0,
      iterations: [],
      successCount: 0,
      failCount: 0,
      consecutiveFailures: 0,
      consecutiveErrors: 0,
      startTime: new Date("2026-01-01T00:00:00Z"),
      waitingUntil: null,
      lastMessage: null,
    };

    const { onInterrupt, orchestratorStop, pause } =
      await runRendererCtrlCTest(state);

    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(orchestratorStop).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
  });
});

describe("Renderer terminal title", () => {
  const escape = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  const titlePrefix = `${escape}]2;`;
  const titleStackPrefix = `${escape}[`;
  const titleStackSuffix = ";0t";

  function setTty(
    target: NodeJS.WriteStream | NodeJS.ReadStream,
    value: boolean,
  ) {
    const original = Object.getOwnPropertyDescriptor(target, "isTTY");
    Object.defineProperty(target, "isTTY", {
      configurable: true,
      value,
    });
    return () => {
      if (original) {
        Object.defineProperty(target, "isTTY", original);
      }
    };
  }

  function extractTerminalTitles(
    stdoutWrite: ReturnType<typeof vi.spyOn>,
  ): string[] {
    const output = stdoutWrite.mock.calls
      .map((args: unknown[]) => String(args[0]))
      .join("");
    return output
      .split(titlePrefix)
      .slice(1)
      .map((segment: string) => segment.split(bell, 1)[0] ?? "");
  }

  function extractTitleStackOps(
    stdoutWrite: ReturnType<typeof vi.spyOn>,
  ): string[] {
    const output = stdoutWrite.mock.calls
      .map((args: unknown[]) => String(args[0]))
      .join("");
    return output
      .split(titleStackPrefix)
      .slice(1)
      .map((segment: string) => segment.split(titleStackSuffix, 1)[0] ?? "")
      .filter((segment: string) => segment === "22" || segment === "23");
  }

  const baseState: OrchestratorState = {
    status: "running",
    gracefulStopRequested: false,
    interruptHint: "resume",
    currentIteration: 1,
    totalInputTokens: 12_400,
    totalOutputTokens: 8_200,
    tokensEstimated: false,
    commitCount: 12,
    iterations: [createIteration()],
    successCount: 1,
    failCount: 0,
    consecutiveFailures: 0,
    consecutiveErrors: 0,
    startTime: new Date("2026-01-01T00:00:00Z"),
    waitingUntil: null,
    lastMessage: "reading files",
  };

  it("writes a running title with the active moon and counters", () => {
    const state = { ...baseState, iterations: [...baseState.iterations] };
    const orchestrator = Object.assign(new EventEmitter(), {
      getState: vi.fn(() => state),
      stop: vi.fn(),
    }) as unknown as Orchestrator;
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const restoreStdinTty = setTty(process.stdin, false);
    const restoreStdoutTty = setTty(process.stdout, true);

    try {
      const renderer = new Renderer(orchestrator, "ship it", "claude", vi.fn());
      renderer.start();

      const titles = extractTerminalTitles(stdoutWrite);
      expect(titles.at(-1)).toMatch(
        /^gnhf [🌑🌒🌓🌔🌕🌖🌗🌘] · 12K in · 8K out · 12 commits$/u,
      );

      renderer.stop();
    } finally {
      restoreStdoutTty();
      restoreStdinTty();
      stdoutWrite.mockRestore();
    }
  });

  it("does not emit title control codes when stdout is not a tty", () => {
    const state = { ...baseState, iterations: [...baseState.iterations] };
    const orchestrator = Object.assign(new EventEmitter(), {
      getState: vi.fn(() => state),
      stop: vi.fn(),
    }) as unknown as Orchestrator;
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const restoreStdinTty = setTty(process.stdin, false);
    const restoreStdoutTty = setTty(process.stdout, false);

    try {
      const renderer = new Renderer(orchestrator, "ship it", "claude", vi.fn());
      renderer.start();
      renderer.stop();

      expect(extractTerminalTitles(stdoutWrite)).toEqual([]);
      expect(extractTitleStackOps(stdoutWrite)).toEqual([]);
    } finally {
      restoreStdoutTty();
      restoreStdinTty();
      stdoutWrite.mockRestore();
    }
  });

  it("updates the title when the run stops", async () => {
    const state = { ...baseState, iterations: [...baseState.iterations] };
    const orchestrator = Object.assign(new EventEmitter(), {
      getState: vi.fn(() => state),
      stop: vi.fn(),
    }) as unknown as Orchestrator;
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const restoreStdinTty = setTty(process.stdin, false);
    const restoreStdoutTty = setTty(process.stdout, true);

    try {
      const renderer = new Renderer(orchestrator, "ship it", "claude", vi.fn());
      renderer.start();
      stdoutWrite.mockClear();

      state.status = "stopped";
      orchestrator.emit("state", {
        ...state,
        iterations: [...state.iterations],
      });
      orchestrator.emit("stopped");

      await expect(renderer.waitUntilExit()).resolves.toBe("stopped");

      const titles = extractTerminalTitles(stdoutWrite);
      const meaningfulTitles = titles.filter((t: string) => t !== "");
      expect(meaningfulTitles.at(-1)).toBe(
        "gnhf stopped · 12K in · 8K out · 12 commits",
      );
    } finally {
      restoreStdoutTty();
      restoreStdinTty();
      stdoutWrite.mockRestore();
    }
  });

  it("stops updating the title after the renderer exits", () => {
    const state = { ...baseState, iterations: [...baseState.iterations] };
    const orchestrator = Object.assign(new EventEmitter(), {
      getState: vi.fn(() => state),
      stop: vi.fn(),
    }) as unknown as Orchestrator;
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const restoreStdinTty = setTty(process.stdin, false);
    const restoreStdoutTty = setTty(process.stdout, true);

    try {
      const renderer = new Renderer(orchestrator, "ship it", "claude", vi.fn());
      renderer.start();
      renderer.stop("interrupted");
      stdoutWrite.mockClear();

      state.status = "stopped";
      orchestrator.emit("state", {
        ...state,
        iterations: [...state.iterations],
      });

      expect(stdoutWrite).not.toHaveBeenCalled();
    } finally {
      restoreStdoutTty();
      restoreStdinTty();
      stdoutWrite.mockRestore();
    }
  });

  it("restores the previous terminal title when the renderer exits", () => {
    const state = { ...baseState, iterations: [...baseState.iterations] };
    const orchestrator = Object.assign(new EventEmitter(), {
      getState: vi.fn(() => state),
      stop: vi.fn(),
    }) as unknown as Orchestrator;
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const restoreStdinTty = setTty(process.stdin, false);
    const restoreStdoutTty = setTty(process.stdout, true);

    try {
      const renderer = new Renderer(orchestrator, "ship it", "claude", vi.fn());
      renderer.start();
      stdoutWrite.mockClear();
      renderer.stop();

      expect(extractTitleStackOps(stdoutWrite)).toEqual(["23"]);
      const titles = extractTerminalTitles(stdoutWrite);
      expect(titles).toContain("");
      const output = stdoutWrite.mock.calls
        .map((args: unknown[]) => String(args[0]))
        .join("");
      const emptyTitleIdx = output.indexOf(`${titlePrefix}${bell}`);
      const restoreIdx = output.indexOf(`${escape}[23${titleStackSuffix}`);
      expect(emptyTitleIdx).toBeGreaterThanOrEqual(0);
      expect(restoreIdx).toBeGreaterThanOrEqual(0);
      expect(emptyTitleIdx).toBeLessThan(restoreIdx);
    } finally {
      restoreStdoutTty();
      restoreStdinTty();
      stdoutWrite.mockRestore();
    }
  });
});
