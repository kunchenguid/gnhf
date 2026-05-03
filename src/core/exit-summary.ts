import type { OrchestratorState } from "./orchestrator.js";
import type { BranchDiffStats } from "./git.js";
import { formatTokens } from "../utils/tokens.js";

type RunStatus = OrchestratorState["status"];

export interface ExitSummaryOptions {
  agentName: string;
  branchName: string;
  elapsedMs: number;
  status: RunStatus;
  abortReason?: string | null;
  iterations: number;
  successCount: number;
  failCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  tokensEstimated: boolean;
  commitCount: number;
  notesPath: string;
  logPath: string;
  baseRef: string;
  diffStats: BranchDiffStats;
  color: boolean;
}

const CARD_WIDTH = 60;
const LABEL_WIDTH = 16;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const NO_MISTAKES_URL = "https://github.com/kunchenguid/no-mistakes";

export function stripExitSummaryAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function makeStyles(color: boolean) {
  const wrap = (open: string, text: string) =>
    color ? `${open}${text}\x1b[0m` : text;
  return {
    dim: (text: string) => wrap("\x1b[2m", text),
    bold: (text: string) => wrap("\x1b[1m", text),
    cyan: (text: string) => wrap("\x1b[36m", text),
    yellow: (text: string) => wrap("\x1b[33m", text),
    green: (text: string) => wrap("\x1b[32m", text),
    red: (text: string) => wrap("\x1b[31m", text),
    magenta: (text: string) => wrap("\x1b[35m", text),
    blueUnderline: (text: string) => wrap("\x1b[34;4m", text),
  };
}

function visibleLength(text: string): number {
  return stripExitSummaryAnsi(text).length;
}

function padVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatTokenCount(
  value: number,
  suffix: "in" | "out",
  estimated: boolean,
) {
  return `${estimated ? "~" : ""}${formatTokens(value)} ${suffix}`;
}

function plural(value: number, singular: string, pluralText = `${singular}s`) {
  return `${formatNumber(value)} ${value === 1 ? singular : pluralText}`;
}

function metricLine(label: string, columns: string[]): string {
  const first = `${padVisible(label, LABEL_WIDTH)}${columns[0] ?? ""}`;
  return `  ${padVisible(first, 30)}${padVisible(columns[1] ?? "", 13)}${columns[2] ?? ""}`;
}

function commandLine(label: string, command: string): string {
  return `  ${padVisible(label, LABEL_WIDTH)}${command}`;
}

function continuationLine(text: string): string {
  return `  ${"".padEnd(LABEL_WIDTH)}${text}`;
}

function cardLine(content: string, dim: (text: string) => string): string {
  return `${dim("│ ")}${padVisible(content, CARD_WIDTH - 2)}${dim(" │")}`;
}

export function renderExitSummary(options: ExitSummaryOptions): string {
  const s = makeStyles(options.color);
  const elapsed = formatDuration(options.elapsedMs);
  const stopped = options.status === "aborted";
  const title = stopped
    ? `${s.red("×")} ${s.bold("gnhf stopped")}`
    : `${s.cyan("✦")} ${s.bold("gnhf wrapped")}`;
  const subtitle = stopped
    ? `${s.cyan(options.agentName)} ran for ${s.yellow(elapsed)} before: ${options.abortReason ?? options.status}`
    : `${s.cyan(options.agentName)} worked for ${s.yellow(elapsed)} on ${s.magenta(options.branchName)}`;
  const rolledBack = `${options.failCount} rolled back`;
  const inputTokens = formatTokenCount(
    options.totalInputTokens,
    "in",
    options.tokensEstimated,
  );
  const outputTokens = formatTokenCount(
    options.totalOutputTokens,
    "out",
    options.tokensEstimated,
  );
  const commits = plural(options.commitCount, "commit");
  const linesAdded = `+${formatNumber(options.diffStats.linesAdded)}`;
  const linesDeleted = `-${formatNumber(options.diffStats.linesDeleted)}`;

  const lines = [
    s.dim(`╭${"─".repeat(CARD_WIDTH)}╮`),
    cardLine(title, s.dim),
    cardLine(`  ${subtitle}`, s.dim),
    s.dim(`╰${"─".repeat(CARD_WIDTH)}╯`),
    "",
    metricLine(s.dim("iterations"), [
      `${s.bold(String(options.iterations))} total`,
      s.green(`${options.successCount} good`),
      stopped ? s.red(rolledBack) : s.yellow(rolledBack),
    ]),
    metricLine(s.dim("tokens"), [s.bold(inputTokens), s.bold(outputTokens)]),
    metricLine(s.dim("branch diff"), [
      s.bold(commits),
      s.green(linesAdded),
      s.red(linesDeleted),
    ]),
    metricLine(s.dim("files"), [
      `${options.diffStats.filesAdded} added`,
      `${options.diffStats.filesUpdated} updated`,
      `${options.diffStats.filesDeleted} deleted`,
    ]),
    "",
    commandLine(s.dim("notes"), options.notesPath),
    commandLine(s.dim("debug log"), options.logPath),
    "",
    commandLine(
      s.dim("next steps"),
      s.cyan(`git log --oneline ${options.baseRef}..HEAD`),
    ),
    continuationLine(s.cyan(`git diff --stat ${options.baseRef}..HEAD`)),
    continuationLine(s.cyan("gh pr create")),
    "",
    commandLine(s.dim("too much?"), `${s.cyan("git push no-mistakes")}:`),
    continuationLine(s.blueUnderline(NO_MISTAKES_URL)),
  ];

  return `\n${lines.join("\n")}\n`;
}
