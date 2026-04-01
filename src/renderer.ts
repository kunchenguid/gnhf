import process from "node:process";
import { generateStarField, getStarState, type Star } from "./utils/stars.js";
import { getMoonPhase } from "./utils/moon.js";
import { formatElapsed } from "./utils/time.js";
import { formatTokens } from "./utils/tokens.js";
import { wordWrap } from "./utils/wordwrap.js";
import type { Orchestrator, OrchestratorState } from "./core/orchestrator.js";
import {
  type Cell,
  type Style,
  textToCells,
  emptyCells,
  rowToString,
  diffFrames,
  emitDiff,
} from "./renderer-diff.js";

// ── Constants ────────────────────────────────────────────────

const CONTENT_WIDTH = 63;
const MAX_PROMPT_LINES = 3;
const BASE_CONTENT_ROWS = 24;
const STAR_DENSITY = 0.035;
const TICK_MS = 200;
const MOONS_PER_ROW = 30;
const MOON_PHASE_PERIOD = 1600;
const MAX_MSG_LINES = 3;
const MAX_MSG_LINE_LEN = 64;
const RESUME_HINT = "[ctrl+c to stop, gnhf again to resume]";

// ── ANSI helpers ─────────────────────────────────────────────

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ── Cell-based render functions ──────────────────────────────

function spacedLabel(text: string): string {
  return text.split("").join(" ");
}

export function renderTitleCells(agentName?: string): Cell[][] {
  const eyebrow: Cell[] = [
    ...textToCells(spacedLabel("gnhf"), "dim"),
    ...(agentName
      ? [
          ...textToCells("  ", "normal"),
          ...textToCells("\u00b7", "dim"),
          ...textToCells("  ", "normal"),
          ...textToCells(spacedLabel(agentName), "dim"),
        ]
      : []),
  ];

  return [
    eyebrow,
    [],
    textToCells(
      "┏━╸┏━┓┏━┓╺┳┓   ┏┓╻╻┏━╸╻ ╻╺┳╸   ╻ ╻┏━┓╻ ╻┏━╸   ┏━╸╻ ╻┏┓╻",
      "bold",
    ),
    textToCells(
      "┃╺┓┃ ┃┃ ┃ ┃┃   ┃┗┫┃┃╺┓┣━┫ ┃    ┣━┫┣━┫┃┏┛┣╸    ┣╸ ┃ ┃┃┗┫",
      "bold",
    ),
    textToCells(
      "┗━┛┗━┛┗━┛╺┻┛   ╹ ╹╹┗━┛╹ ╹ ╹    ╹ ╹╹ ╹┗┛ ┗━╸   ╹  ┗━┛╹ ╹",
      "bold",
    ),
  ];
}

export function renderStatsCells(
  elapsed: string,
  inputTokens: number,
  outputTokens: number,
  commitCount: number,
): Cell[] {
  const commitLabel = commitCount === 1 ? "commit" : "commits";
  return [
    ...textToCells(elapsed, "bold"),
    ...textToCells("  ", "normal"),
    ...textToCells("\u00b7", "dim"),
    ...textToCells("  ", "normal"),
    ...textToCells(`${formatTokens(inputTokens)} in`, "normal"),
    ...textToCells("  ", "normal"),
    ...textToCells("\u00b7", "dim"),
    ...textToCells("  ", "normal"),
    ...textToCells(`${formatTokens(outputTokens)} out`, "normal"),
    ...textToCells("  ", "normal"),
    ...textToCells("\u00b7", "dim"),
    ...textToCells("  ", "normal"),
    ...textToCells(`${commitCount} ${commitLabel}`, "normal"),
  ];
}

export function renderAgentMessageCells(
  message: string | null,
  status: string,
): Cell[][] {
  const lines: string[] = [];
  if (status === "waiting") {
    lines.push("waiting (backoff)...");
  } else if (status === "aborted" && !message) {
    lines.push("max consecutive failures reached");
  } else if (!message) {
    lines.push("working...");
  } else {
    const wrapped = wordWrap(message, MAX_MSG_LINE_LEN, MAX_MSG_LINES);
    for (const wl of wrapped) {
      lines.push(wl);
    }
  }
  while (lines.length < MAX_MSG_LINES) lines.push("");
  return lines.map((l) => (l ? textToCells(l, "dim") : []));
}

export function renderMoonStripCells(
  iterations: { success: boolean }[],
  isRunning: boolean,
  now: number,
): Cell[][] {
  const moons: string[] = iterations.map((iter) =>
    getMoonPhase(iter.success ? "success" : "fail"),
  );
  if (isRunning) {
    moons.push(getMoonPhase("active", now, MOON_PHASE_PERIOD));
  }
  if (moons.length === 0) return [[]];
  const rows: Cell[][] = [];
  for (let i = 0; i < moons.length; i += MOONS_PER_ROW) {
    const slice = moons.slice(i, i + MOONS_PER_ROW);
    const cells: Cell[] = [];
    for (const moon of slice) {
      cells.push(...textToCells(moon, "normal"));
    }
    rows.push(cells);
  }
  return rows;
}

// ── String wrappers (preserve existing API) ──────────────────

export function renderTitle(agentName?: string): string[] {
  return renderTitleCells(agentName).map(rowToString);
}

export function renderStats(
  elapsed: string,
  inputTokens: number,
  outputTokens: number,
  commitCount: number,
): string {
  return rowToString(
    renderStatsCells(elapsed, inputTokens, outputTokens, commitCount),
  );
}

export function renderAgentMessage(
  message: string | null,
  status: string,
): string[] {
  return renderAgentMessageCells(message, status).map(rowToString);
}

export function renderMoonStrip(
  iterations: { success: boolean }[],
  isRunning: boolean,
  now: number,
): string[] {
  return renderMoonStripCells(iterations, isRunning, now).map(rowToString);
}

// ── Star rendering (cell-based) ─────────────────────────────

function starStyle(state: "bright" | "dim" | "hidden"): Style {
  if (state === "bright") return "bold";
  if (state === "dim") return "dim";
  return "normal";
}

function placeStarsInCells(
  cells: Cell[],
  stars: Star[],
  row: number,
  xMin: number,
  xMax: number,
  xOffset: number,
  now: number,
): void {
  for (const star of stars) {
    if (star.y !== row || star.x < xMin || star.x >= xMax) continue;
    const state = getStarState(star, now);
    const localX = star.x - xOffset;
    cells[localX] =
      state === "hidden"
        ? { char: " ", style: "normal", width: 1 }
        : { char: star.char, style: starStyle(state), width: 1 };
  }
}

function renderStarLineCells(
  stars: Star[],
  width: number,
  y: number,
  now: number,
): Cell[] {
  const cells = emptyCells(width);
  placeStarsInCells(cells, stars, y, 0, width, 0, now);
  return cells;
}

export function renderStarFieldLines(
  seed: number,
  width: number,
  height: number,
  now: number,
): string[] {
  const stars = generateStarField(width, height, STAR_DENSITY, seed);
  const lines: string[] = [];
  for (let y = 0; y < height; y++) {
    lines.push(rowToString(renderStarLineCells(stars, width, y, now)));
  }
  return lines;
}

function renderSideStarsCells(
  stars: Star[],
  rowIndex: number,
  xOffset: number,
  sideWidth: number,
  now: number,
): Cell[] {
  if (sideWidth <= 0) return [];
  const cells = emptyCells(sideWidth);
  placeStarsInCells(
    cells,
    stars,
    rowIndex,
    xOffset,
    xOffset + sideWidth,
    xOffset,
    now,
  );
  return cells;
}

function centerLineCells(content: Cell[], width: number): Cell[] {
  const w = content.length;
  const pad = Math.max(0, Math.floor((width - w) / 2));
  const rightPad = Math.max(0, width - w - pad);
  return [...emptyCells(pad), ...content, ...emptyCells(rightPad)];
}

function renderResumeHintCells(width: number): Cell[] {
  return centerLineCells(textToCells(RESUME_HINT, "dim"), width);
}

function fitContentRows(contentRows: Cell[][], maxRows: number): Cell[][] {
  if (contentRows.length <= maxRows) return contentRows;

  const fitted = [...contentRows];

  while (fitted.length > maxRows) {
    const emptyRowIndex = fitted.findIndex((row) => row.length === 0);
    if (emptyRowIndex === -1) break;
    fitted.splice(emptyRowIndex, 1);
  }

  return fitted.length > maxRows
    ? fitted.slice(fitted.length - maxRows)
    : fitted;
}

// ── Build full frame (cell-based) ────────────────────────────

export function buildContentCells(
  prompt: string,
  agentName: string,
  state: OrchestratorState,
  elapsed: string,
  now: number,
): Cell[][] {
  const rows: Cell[][] = [];
  const isRunning = state.status === "running" || state.status === "waiting";

  rows.push([]);
  rows.push(...renderTitleCells(agentName));
  rows.push([], []);

  const promptLines = wordWrap(prompt, CONTENT_WIDTH, MAX_PROMPT_LINES);
  for (let i = 0; i < MAX_PROMPT_LINES; i++) {
    const pl = promptLines[i] ?? "";
    rows.push(pl ? textToCells(pl, "dim") : []);
  }

  rows.push([], []);
  rows.push(
    renderStatsCells(
      elapsed,
      state.totalInputTokens,
      state.totalOutputTokens,
      state.commitCount,
    ),
  );
  rows.push([], []);
  rows.push(...renderAgentMessageCells(state.lastMessage, state.status));
  rows.push([], []);
  rows.push(...renderMoonStripCells(state.iterations, isRunning, now));

  return rows;
}

export function buildFrameCells(
  prompt: string,
  agentName: string,
  state: OrchestratorState,
  topStars: Star[],
  bottomStars: Star[],
  sideStars: Star[],
  now: number,
  terminalWidth: number,
  terminalHeight: number,
): Cell[][] {
  const elapsed = formatElapsed(now - state.startTime.getTime());
  const reservedBottomRows = 2;
  const availableHeight = Math.max(0, terminalHeight - reservedBottomRows);
  const contentRows = fitContentRows(
    buildContentCells(prompt, agentName, state, elapsed, now),
    availableHeight,
  );

  while (contentRows.length < Math.min(BASE_CONTENT_ROWS, availableHeight)) {
    contentRows.push([]);
  }

  const contentCount = contentRows.length;
  const remaining = Math.max(0, availableHeight - contentCount);
  const topHeight = Math.max(0, Math.ceil(remaining / 2));
  const bottomHeight = remaining - topHeight;

  const sideWidth = Math.max(
    0,
    Math.floor((terminalWidth - CONTENT_WIDTH) / 2),
  );

  const frame: Cell[][] = [];

  for (let y = 0; y < topHeight; y++) {
    frame.push(renderStarLineCells(topStars, terminalWidth, y, now));
  }

  for (let i = 0; i < contentRows.length; i++) {
    const left = renderSideStarsCells(sideStars, i, 0, sideWidth, now);
    const center = centerLineCells(contentRows[i], CONTENT_WIDTH);
    const right = renderSideStarsCells(
      sideStars,
      i,
      terminalWidth - sideWidth,
      sideWidth,
      now,
    );
    frame.push([...left, ...center, ...right]);
  }

  for (let y = 0; y < bottomHeight; y++) {
    frame.push(renderStarLineCells(bottomStars, terminalWidth, y, now));
  }

  frame.push(renderResumeHintCells(terminalWidth));
  frame.push(emptyCells(terminalWidth));

  return frame;
}

// ── String wrappers for frame building ───────────────────────

export function buildContentLines(
  prompt: string,
  agentName: string,
  state: OrchestratorState,
  elapsed: string,
  now: number,
): string[] {
  return buildContentCells(prompt, agentName, state, elapsed, now).map(
    rowToString,
  );
}

export function buildFrame(
  prompt: string,
  agentName: string,
  state: OrchestratorState,
  topStars: Star[],
  bottomStars: Star[],
  sideStars: Star[],
  now: number,
  terminalWidth: number,
  terminalHeight: number,
): string {
  const cells = buildFrameCells(
    prompt,
    agentName,
    state,
    topStars,
    bottomStars,
    sideStars,
    now,
    terminalWidth,
    terminalHeight,
  );
  return "\x1b[H" + cells.map(rowToString).join("\n");
}

// ── Renderer class ───────────────────────────────────────────

export class Renderer {
  private orchestrator: Orchestrator;
  private prompt: string;
  private agentName: string;
  private state: OrchestratorState;
  private interval: ReturnType<typeof setInterval> | null = null;
  private exitResolve!: () => void;
  private exitPromise: Promise<void>;
  private topStars: Star[] = [];
  private bottomStars: Star[] = [];
  private sideStars: Star[] = [];
  private cachedWidth = 0;
  private cachedHeight = 0;
  private prevCells: Cell[][] = [];
  private isFirstFrame = true;

  constructor(orchestrator: Orchestrator, prompt: string, agentName: string) {
    this.orchestrator = orchestrator;
    this.prompt = prompt;
    this.agentName = agentName;
    this.state = orchestrator.getState();
    this.exitPromise = new Promise((resolve) => {
      this.exitResolve = resolve;
    });
  }

  start(): void {
    this.orchestrator.on("state", (newState) => {
      this.state = { ...newState, iterations: [...newState.iterations] };
    });

    this.orchestrator.on("stopped", () => {
      this.stop();
    });

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", (data) => {
        if (data[0] === 3) {
          this.stop();
          this.orchestrator.stop();
        }
      });
    }

    this.interval = setInterval(() => this.render(), TICK_MS);
    this.render();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeAllListeners("data");
    }
    this.exitResolve();
  }

  waitUntilExit(): Promise<void> {
    return this.exitPromise;
  }

  private ensureStarFields(w: number, h: number): boolean {
    if (w !== this.cachedWidth || h !== this.cachedHeight) {
      this.cachedWidth = w;
      this.cachedHeight = h;
      const contentStart = Math.max(0, Math.floor((w - CONTENT_WIDTH) / 2) - 8);
      const contentEnd = contentStart + CONTENT_WIDTH + 16;
      const availableHeight = Math.max(0, h - 2);
      const remaining = Math.max(0, availableHeight - BASE_CONTENT_ROWS);
      const topHeight = Math.max(0, Math.ceil(remaining / 2));
      const proximityRows = 8;
      const shrinkBig = (s: Star, nearContentRow: boolean): Star => {
        if (!nearContentRow || s.x < contentStart || s.x >= contentEnd)
          return s;
        const star = s.char !== "·" ? { ...s, char: "·" } : s;
        return star.rest === "bright" ? { ...star, rest: "dim" } : star;
      };
      this.topStars = generateStarField(w, h, STAR_DENSITY, 42).map((s) =>
        shrinkBig(s, s.y >= topHeight - proximityRows),
      );
      this.bottomStars = generateStarField(w, h, STAR_DENSITY, 137).map((s) =>
        shrinkBig(s, s.y < proximityRows),
      );
      this.sideStars = generateStarField(
        w,
        Math.max(BASE_CONTENT_ROWS, availableHeight),
        STAR_DENSITY,
        99,
      );
      return true;
    }
    return false;
  }

  private render(): void {
    const now = Date.now();
    const w = process.stdout.columns || 80;
    const h = process.stdout.rows || 24;
    const resized = this.ensureStarFields(w, h);

    const nextCells = buildFrameCells(
      this.prompt,
      this.agentName,
      this.state,
      this.topStars,
      this.bottomStars,
      this.sideStars,
      now,
      w,
      h,
    );

    if (this.isFirstFrame || resized) {
      process.stdout.write("\x1b[H" + nextCells.map(rowToString).join("\n"));
      this.isFirstFrame = false;
    } else {
      const changes = diffFrames(this.prevCells, nextCells);
      if (changes.length > 0) {
        process.stdout.write(emitDiff(changes));
      }
    }

    this.prevCells = nextCells;
  }
}
