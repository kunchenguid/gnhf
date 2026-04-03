import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import {
  Renderer,
  stripAnsi,
  renderTitle,
  renderStats,
  renderAgentMessage,
  renderMoonStrip,
  renderStarFieldLines,
  buildFrame,
  buildContentCells,
} from "./renderer.js";
import { rowToString } from "./renderer-diff.js";
import type { Orchestrator, OrchestratorState } from "./core/orchestrator.js";

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
      "[ctrl+c to stop, gnhf again to resume]",
    );
    expect(plainLines.at(-1)?.trim()).toBe("");
  });

  it("keeps stats visible when moon rows exceed the content viewport", () => {
    const state: OrchestratorState = {
      status: "done",
      currentIteration: 660,
      totalInputTokens: 1200,
      totalOutputTokens: 800,
      commitCount: 7,
      iterations: Array.from({ length: 660 }, (_, index) => ({
        iteration: index + 1,
        success: true,
      })),
      successCount: 660,
      failCount: 0,
      consecutiveFailures: 0,
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
      currentIteration: 1,
      totalInputTokens: 100,
      totalOutputTokens: 50,
      commitCount: 1,
      iterations: [{ success: true }],
      successCount: 1,
      failCount: 0,
      consecutiveFailures: 0,
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
});

describe("buildContentCells adaptive height", () => {
  const state: OrchestratorState = {
    status: "running",
    currentIteration: 1,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    commitCount: 1,
    iterations: [{ success: true }],
    successCount: 1,
    failCount: 0,
    consecutiveFailures: 0,
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
        status: "done",
        iterations: Array.from({ length: 660 }, () => ({ success: true })),
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
        status: "done",
        iterations: Array.from({ length: 660 }, () => ({ success: true })),
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
  it("hides immediately and then requests orchestrator stop", async () => {
    vi.useFakeTimers();

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

    let dataHandler: ((data: Buffer) => void) | null = null;
    const orchestrator = Object.assign(new EventEmitter(), {
      getState: vi.fn(() => state),
      stop: vi.fn(),
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
    (
      process.stdin as NodeJS.ReadStream & {
        setRawMode: ReturnType<typeof vi.fn>;
      }
    ).setRawMode = vi.fn();
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

    try {
      const renderer = new Renderer(orchestrator, "ship it", "claude");
      renderer.start();

      expect(dataHandler).not.toBeNull();
      dataHandler?.(Buffer.from([3]));

      await expect(renderer.waitUntilExit()).resolves.toBe("interrupted");

      expect(
        orchestrator.stop as ReturnType<typeof vi.fn>,
      ).toHaveBeenCalledTimes(1);
      expect(process.stdin.pause).toHaveBeenCalledTimes(1);
      expect(process.stdin.removeAllListeners).toHaveBeenCalledWith("data");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: originalIsTTY,
      });
      (
        process.stdin as NodeJS.ReadStream & {
          setRawMode?: (mode: boolean) => void;
        }
      ).setRawMode = originalSetRawMode;
      process.stdin.resume = originalResume;
      process.stdin.pause = originalPause;
      process.stdin.on = originalOn;
      process.stdin.removeAllListeners = originalRemoveAllListeners;
      stdoutWrite.mockRestore();
      vi.useRealTimers();
    }
  });
});
