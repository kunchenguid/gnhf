import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { AGENT_OUTPUT_SCHEMA } from "./agents/types.js";

export interface RunInfo {
  runId: string;
  runDir: string;
  promptPath: string;
  notesPath: string;
  schemaPath: string;
}

function ensureGitignore(cwd: string): void {
  const gitignorePath = join(cwd, ".gitignore");
  const entry = ".gnhf/runs/";

  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (content.split("\n").some((line) => line.trim() === entry)) return;
    appendFileSync(gitignorePath, `\n${entry}\n`, "utf-8");
  } else {
    writeFileSync(gitignorePath, `${entry}\n`, "utf-8");
  }
}

export function setupRun(runId: string, prompt: string, cwd: string): RunInfo {
  ensureGitignore(cwd);

  const runDir = join(cwd, ".gnhf", "runs", runId);
  mkdirSync(runDir, { recursive: true });

  const promptPath = join(runDir, "prompt.md");
  writeFileSync(promptPath, prompt, "utf-8");

  const notesPath = join(runDir, "notes.md");
  writeFileSync(
    notesPath,
    `# gnhf run: ${runId}\n\nObjective: ${prompt}\n\n## Iteration Log\n`,
    "utf-8",
  );

  const schemaPath = join(runDir, "output-schema.json");
  writeFileSync(
    schemaPath,
    JSON.stringify(AGENT_OUTPUT_SCHEMA, null, 2),
    "utf-8",
  );

  return { runId, runDir, promptPath, notesPath, schemaPath };
}

export function resumeRun(runId: string, cwd: string): RunInfo {
  const runDir = join(cwd, ".gnhf", "runs", runId);
  if (!existsSync(runDir)) {
    throw new Error(`Run directory not found: ${runDir}`);
  }

  const promptPath = join(runDir, "prompt.md");
  const notesPath = join(runDir, "notes.md");
  const schemaPath = join(runDir, "output-schema.json");

  return { runId, runDir, promptPath, notesPath, schemaPath };
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
    changes.length > 0
      ? `**Changes:**\n${changes.map((c) => `- ${c}`).join("\n")}\n`
      : "",
    learnings.length > 0
      ? `**Learnings:**\n${learnings.map((l) => `- ${l}`).join("\n")}\n`
      : "",
  ].join("\n");

  appendFileSync(notesPath, entry, "utf-8");
}
