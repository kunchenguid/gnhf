import type { AgentOutput, AgentOutputCommitField } from "./agents/types.js";

export type CommitMessagePreset = "conventional";

export interface CommitMessageConfig {
  preset: CommitMessagePreset;
}

export interface CommitMessageContext {
  iteration: number;
}

export interface CommitMessagePromptField {
  name: string;
  description: string;
  allowed?: string[];
  default: string;
}

type AgentOutputWithCommitMessageFields = AgentOutput & {
  type?: unknown;
  scope?: unknown;
};

export const CONVENTIONAL_COMMIT_MESSAGE: CommitMessageConfig = {
  preset: "conventional",
};

const CONVENTIONAL_COMMIT_TYPES = [
  "build",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "test",
  "chore",
];

const CONVENTIONAL_COMMIT_MESSAGE_FIELDS: CommitMessagePromptField[] = [
  {
    name: "type",
    description: "Commit type",
    allowed: CONVENTIONAL_COMMIT_TYPES,
    default: "chore",
  },
  {
    name: "scope",
    description: "Optional commit scope",
    default: "",
  },
];

export function getCommitMessageSchemaFields(
  config: CommitMessageConfig | undefined,
): AgentOutputCommitField[] {
  if (config === undefined) return [];
  return CONVENTIONAL_COMMIT_MESSAGE_FIELDS.map((field) => ({
    name: field.name,
    ...(field.allowed === undefined ? {} : { allowed: field.allowed }),
  }));
}

export function getCommitMessagePromptFields(
  config: CommitMessageConfig | undefined,
): CommitMessagePromptField[] {
  if (config === undefined) return [];
  return CONVENTIONAL_COMMIT_MESSAGE_FIELDS;
}

function collapseHeader(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

function outputString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function resolveConventionalType(value: unknown): string {
  const candidate = outputString(value);
  if (candidate !== null && CONVENTIONAL_COMMIT_TYPES.includes(candidate)) {
    return candidate;
  }
  return "chore";
}

function resolveConventionalScope(value: unknown): string {
  const scope = outputString(value)?.trim() ?? "";
  return scope === "" ? "" : `(${scope})`;
}

export function buildCommitMessage(
  config: CommitMessageConfig | undefined,
  output: AgentOutput,
  context: CommitMessageContext,
): string {
  if (config === undefined) {
    return collapseHeader(`gnhf #${context.iteration}: ${output.summary}`);
  }

  const commitOutput = output as AgentOutputWithCommitMessageFields;
  const type = resolveConventionalType(commitOutput.type);
  const scope = resolveConventionalScope(commitOutput.scope);
  return collapseHeader(`${type}${scope}: ${output.summary}`);
}
