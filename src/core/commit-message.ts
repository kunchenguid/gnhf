import type { AgentOutput, AgentOutputCommitField } from "./agents/types.js";

export type CommitMessagePreset = "angular";

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

export const ANGULAR_COMMIT_MESSAGE: CommitMessageConfig = {
  preset: "angular",
};

const ANGULAR_COMMIT_TYPES = [
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

const ANGULAR_COMMIT_MESSAGE_FIELDS: CommitMessagePromptField[] = [
  {
    name: "type",
    description: "Commit type",
    allowed: ANGULAR_COMMIT_TYPES,
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
  return ANGULAR_COMMIT_MESSAGE_FIELDS.map((field) => ({
    name: field.name,
    ...(field.allowed === undefined ? {} : { allowed: field.allowed }),
  }));
}

export function getCommitMessagePromptFields(
  config: CommitMessageConfig | undefined,
): CommitMessagePromptField[] {
  if (config === undefined) return [];
  return ANGULAR_COMMIT_MESSAGE_FIELDS;
}

function collapseHeader(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

function outputString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function resolveAngularType(value: unknown): string {
  const candidate = outputString(value);
  if (candidate !== null && ANGULAR_COMMIT_TYPES.includes(candidate)) {
    return candidate;
  }
  return "chore";
}

function resolveAngularScope(value: unknown): string {
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

  const type = resolveAngularType(output.type);
  const scope = resolveAngularScope(output.scope);
  return collapseHeader(`${type}${scope}: ${output.summary}`);
}
