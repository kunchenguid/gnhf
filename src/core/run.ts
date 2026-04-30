import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildAgentOutputSchema,
  type AgentOutputCommitField,
} from "./agents/types.js";
import {
  CONVENTIONAL_COMMIT_MESSAGE,
  getCommitMessageSchemaFields,
  type CommitMessageConfig,
} from "./commit-message.js";
import { findLegacyRunBaseCommit, getHeadCommit } from "./git.js";

export interface RunInfo {
  runId: string;
  runDir: string;
  promptPath: string;
  notesPath: string;
  schemaPath: string;
  logPath: string;
  baseCommit: string;
  baseCommitPath: string;
  stopWhenPath: string;
  stopWhen: string | undefined;
  commitMessagePath: string;
  commitMessage: CommitMessageConfig | undefined;
}

export interface RunMetadata {
  runId: string;
  runDir: string;
  promptPath: string;
  schemaPath: string;
  commitMessagePath: string;
  commitMessage: CommitMessageConfig | undefined;
}

const LOG_FILENAME = "gnhf.log";
const STOP_WHEN_FILENAME = "stop-when";
const COMMIT_MESSAGE_FILENAME = "commit-message";

function writeSchemaFile(
  schemaPath: string,
  schemaOptions: RunSchemaOptions,
): void {
  writeFileSync(
    schemaPath,
    JSON.stringify(
      buildAgentOutputSchema({
        includeStopField: schemaOptions.includeStopField,
        commitFields: schemaOptions.commitFields,
      }),
      null,
      2,
    ),
    "utf-8",
  );
}

export interface RunSchemaOptions {
  includeStopField: boolean;
  commitFields?: AgentOutputCommitField[];
  commitMessage?: CommitMessageConfig;
  stopWhen?: string;
  clearStopWhen?: boolean;
}

function readStopWhen(stopWhenPath: string): string | undefined {
  if (!existsSync(stopWhenPath)) return undefined;
  const stopWhen = readFileSync(stopWhenPath, "utf-8").trim();
  return stopWhen.length > 0 ? stopWhen : undefined;
}

function commitMessageMetadataValue(
  commitMessage: CommitMessageConfig | undefined,
): "default" | "conventional" {
  return commitMessage?.preset ?? "default";
}

function readCommitMessageMetadata(
  commitMessagePath: string,
): CommitMessageConfig | undefined {
  const value = readFileSync(commitMessagePath, "utf-8").trim();
  if (value === "" || value === "default") return undefined;
  if (value === "conventional") return CONVENTIONAL_COMMIT_MESSAGE;
  throw new Error(`Unknown commit message metadata: ${value}`);
}

function inferCommitMessageFromSchema(
  schemaPath: string,
): CommitMessageConfig | undefined {
  if (!existsSync(schemaPath)) return undefined;
  try {
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as {
      properties?: Record<string, unknown>;
    };
    if (
      schema.properties?.type !== undefined &&
      schema.properties.scope !== undefined
    ) {
      return CONVENTIONAL_COMMIT_MESSAGE;
    }
  } catch {
    // Legacy metadata is best-effort; malformed schemas fall back to default.
  }
  return undefined;
}

function resolveRunCommitMessage(
  commitMessagePath: string,
  schemaPath: string,
): CommitMessageConfig | undefined {
  if (existsSync(commitMessagePath)) {
    return readCommitMessageMetadata(commitMessagePath);
  }

  const commitMessage = inferCommitMessageFromSchema(schemaPath);
  writeFileSync(
    commitMessagePath,
    `${commitMessageMetadataValue(commitMessage)}\n`,
    "utf-8",
  );
  return commitMessage;
}

function peekRunCommitMessage(
  commitMessagePath: string,
  schemaPath: string,
): CommitMessageConfig | undefined {
  if (existsSync(commitMessagePath)) {
    return readCommitMessageMetadata(commitMessagePath);
  }

  return inferCommitMessageFromSchema(schemaPath);
}

function writeCommitMessageMetadata(
  commitMessagePath: string,
  commitMessage: CommitMessageConfig | undefined,
): void {
  writeFileSync(
    commitMessagePath,
    `${commitMessageMetadataValue(commitMessage)}\n`,
    "utf-8",
  );
}

function ensureRunMetadataIgnored(cwd: string): void {
  const excludePath = execFileSync(
    "git",
    ["rev-parse", "--git-path", "info/exclude"],
    { cwd, encoding: "utf-8" },
  ).trim();
  const resolved = isAbsolute(excludePath)
    ? excludePath
    : join(cwd, excludePath);
  const entry = ".gnhf/runs/";
  mkdirSync(dirname(resolved), { recursive: true });

  if (existsSync(resolved)) {
    const content = readFileSync(resolved, "utf-8");
    if (content.split("\n").some((line) => line.trim() === entry)) return;
    const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    appendFileSync(resolved, `${separator}${entry}\n`, "utf-8");
  } else {
    // This ignore rule is runtime metadata, so keep it local to the clone
    // instead of mutating tracked .gitignore state on startup.
    writeFileSync(resolved, `${entry}\n`, "utf-8");
  }
}

export function setupRun(
  runId: string,
  prompt: string,
  baseCommit: string,
  cwd: string,
  schemaOptions: RunSchemaOptions,
): RunInfo {
  ensureRunMetadataIgnored(cwd);

  const runDir = join(cwd, ".gnhf", "runs", runId);
  mkdirSync(runDir, { recursive: true });

  const promptPath = join(runDir, "prompt.md");
  writeFileSync(promptPath, prompt, "utf-8");

  const notesPath = join(runDir, "notes.md");
  if (!existsSync(notesPath)) {
    writeFileSync(
      notesPath,
      `# gnhf run: ${runId}\n\nObjective: see .gnhf/runs/${runId}/prompt.md\n\n## Iteration Log\n`,
      "utf-8",
    );
  }

  const schemaPath = join(runDir, "output-schema.json");
  writeSchemaFile(schemaPath, schemaOptions);

  const logPath = join(runDir, LOG_FILENAME);

  const baseCommitPath = join(runDir, "base-commit");
  const hasStoredBaseCommit = existsSync(baseCommitPath);
  const resolvedBaseCommit = hasStoredBaseCommit
    ? readFileSync(baseCommitPath, "utf-8").trim()
    : baseCommit;
  if (!hasStoredBaseCommit) {
    writeFileSync(baseCommitPath, `${baseCommit}\n`, "utf-8");
  }

  const stopWhenPath = join(runDir, STOP_WHEN_FILENAME);
  const stopWhen = schemaOptions.stopWhen;
  if (stopWhen !== undefined) {
    writeFileSync(stopWhenPath, `${stopWhen}\n`, "utf-8");
  }
  const commitMessagePath = join(runDir, COMMIT_MESSAGE_FILENAME);
  const commitMessage = schemaOptions.commitMessage;
  writeCommitMessageMetadata(commitMessagePath, commitMessage);

  return {
    runId,
    runDir,
    promptPath,
    notesPath,
    schemaPath,
    logPath,
    baseCommit: resolvedBaseCommit,
    baseCommitPath,
    stopWhenPath,
    stopWhen,
    commitMessagePath,
    commitMessage,
  };
}

export function resumeRun(
  runId: string,
  cwd: string,
  schemaOptions: RunSchemaOptions,
): RunInfo {
  const runDir = join(cwd, ".gnhf", "runs", runId);
  if (!existsSync(runDir)) {
    throw new Error(`Run directory not found: ${runDir}`);
  }

  const promptPath = join(runDir, "prompt.md");
  const notesPath = join(runDir, "notes.md");
  const schemaPath = join(runDir, "output-schema.json");
  const logPath = join(runDir, LOG_FILENAME);
  const baseCommitPath = join(runDir, "base-commit");
  const baseCommit = existsSync(baseCommitPath)
    ? readFileSync(baseCommitPath, "utf-8").trim()
    : backfillLegacyBaseCommit(runId, baseCommitPath, cwd);
  const stopWhenPath = join(runDir, STOP_WHEN_FILENAME);
  let stopWhen = readStopWhen(stopWhenPath);
  if (schemaOptions.clearStopWhen) {
    rmSync(stopWhenPath, { force: true });
    stopWhen = undefined;
  } else if (schemaOptions.stopWhen !== undefined) {
    stopWhen = schemaOptions.stopWhen;
    writeFileSync(stopWhenPath, `${stopWhen}\n`, "utf-8");
  }
  const commitMessagePath = join(runDir, COMMIT_MESSAGE_FILENAME);
  const commitMessage = resolveRunCommitMessage(commitMessagePath, schemaPath);
  writeSchemaFile(schemaPath, {
    ...schemaOptions,
    commitMessage,
    commitFields: getCommitMessageSchemaFields(commitMessage),
    includeStopField: schemaOptions.includeStopField || stopWhen !== undefined,
  });

  return {
    runId,
    runDir,
    promptPath,
    notesPath,
    schemaPath,
    logPath,
    baseCommit,
    baseCommitPath,
    stopWhenPath,
    stopWhen,
    commitMessagePath,
    commitMessage,
  };
}

export function peekRunMetadata(runId: string, cwd: string): RunMetadata {
  const runDir = join(cwd, ".gnhf", "runs", runId);
  if (!existsSync(runDir)) {
    throw new Error(`Run directory not found: ${runDir}`);
  }

  const promptPath = join(runDir, "prompt.md");
  const schemaPath = join(runDir, "output-schema.json");
  const commitMessagePath = join(runDir, COMMIT_MESSAGE_FILENAME);
  const commitMessage = peekRunCommitMessage(commitMessagePath, schemaPath);

  return {
    runId,
    runDir,
    promptPath,
    schemaPath,
    commitMessagePath,
    commitMessage,
  };
}

function backfillLegacyBaseCommit(
  runId: string,
  baseCommitPath: string,
  cwd: string,
): string {
  const baseCommit = findLegacyRunBaseCommit(runId, cwd) ?? getHeadCommit(cwd);
  writeFileSync(baseCommitPath, `${baseCommit}\n`, "utf-8");
  return baseCommit;
}

export function getLastIterationNumber(runInfo: RunInfo): number {
  const files = readdirSync(runInfo.runDir);
  let max = 0;
  for (const f of files) {
    const m = f.match(/^iteration-(\d+)\.jsonl$/);
    if (m) {
      const n = parseInt(m[1]!, 10);
      if (n > max) max = n;
    }
  }
  return max;
}

export function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === "string");
      }
    } catch {
      // Not JSON — fall through to render raw
    }
    return [value];
  }
  return [];
}

function formatListSection(title: string, items: string[]): string {
  if (items.length === 0) return "";
  return `**${title}:**\n${items.map((item) => `- ${item}`).join("\n")}\n`;
}

export function appendNotes(
  notesPath: string,
  iteration: number,
  summary: string,
  changes: string[],
  learnings: string[],
): void {
  const entry = [
    `\n### Iteration ${iteration}\n`,
    `**Summary:** ${summary}\n`,
    formatListSection("Changes", changes),
    formatListSection("Learnings", learnings),
  ].join("\n");

  appendFileSync(notesPath, entry, "utf-8");
}
