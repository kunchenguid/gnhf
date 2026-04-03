import { graphemeWidth, splitGraphemes } from "./utils/terminal-width.js";

// ── Cell types ───────────────────────────────────────────────

export type Style = "normal" | "bold" | "dim";

export interface Cell {
  char: string;
  style: Style;
  /** 1 = normal grapheme, 2 = wide grapheme, 0 = continuation of a wide grapheme */
  width: number;
}

export interface Change {
  row: number;
  col: number;
  cell: Cell;
}

// ── Cell helpers ─────────────────────────────────────────────

const SPACE: Cell = { char: " ", style: "normal", width: 1 };

export function makeCell(char: string, style: Style): Cell {
  return { char, style, width: graphemeWidth(char) };
}

export function textToCells(text: string, style: Style): Cell[] {
  const cells: Cell[] = [];
  for (const grapheme of splitGraphemes(text)) {
    const cell = makeCell(grapheme, style);
    cells.push(cell);
    if (cell.width === 2) {
      cells.push({ char: "", style: "normal", width: 0 });
    }
  }
  return cells;
}

export function emptyCells(n: number): Cell[] {
  const cells: Cell[] = [];
  for (let i = 0; i < n; i++) {
    cells.push({ ...SPACE });
  }
  return cells;
}

// ── Cell → string conversion ────────────────────────────────

export function rowToString(cells: Cell[]): string {
  let result = "";
  let currentStyle: Style = "normal";
  for (const cell of cells) {
    if (cell.width === 0) continue;
    if (cell.style !== currentStyle) {
      if (currentStyle !== "normal") result += "\x1b[0m";
      if (cell.style === "bold") result += "\x1b[1m";
      else if (cell.style === "dim") result += "\x1b[2m";
      currentStyle = cell.style;
    }
    result += cell.char;
  }
  if (currentStyle !== "normal") result += "\x1b[0m";
  return result;
}

// ── Frame diffing ────────────────────────────────────────────

export function diffFrames(prev: Cell[][], next: Cell[][]): Change[] {
  const changes: Change[] = [];
  const rows = Math.min(prev.length, next.length);
  for (let r = 0; r < rows; r++) {
    const prevRow = prev[r];
    const nextRow = next[r];
    const cols = Math.min(prevRow.length, nextRow.length);
    for (let c = 0; c < cols; c++) {
      const n = nextRow[c];
      if (n.width === 0) continue;
      const p = prevRow[c];
      if (p.char !== n.char || p.style !== n.style || p.width !== n.width) {
        changes.push({ row: r, col: c, cell: n });
      }
    }
  }
  return changes;
}

// ── Diff → ANSI output ──────────────────────────────────────

export function emitDiff(changes: Change[]): string {
  if (changes.length === 0) return "";

  let result = "";
  let currentStyle: Style | null = null;
  let cursorRow = -1;
  let cursorCol = -1;

  for (const { row, col, cell } of changes) {
    if (row !== cursorRow || col !== cursorCol) {
      result += `\x1b[${row + 1};${col + 1}H`;
    }

    if (cell.style !== currentStyle) {
      result += "\x1b[0m";
      if (cell.style === "bold") result += "\x1b[1m";
      else if (cell.style === "dim") result += "\x1b[2m";
      currentStyle = cell.style;
    }

    result += cell.char;
    cursorRow = row;
    cursorCol = col + cell.width;
  }

  if (currentStyle !== "normal") result += "\x1b[0m";
  return result;
}
