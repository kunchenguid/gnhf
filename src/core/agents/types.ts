export interface AgentOutput {
  success: boolean;
  summary: string;
  key_changes_made: unknown;
  key_learnings: unknown;
  should_fully_stop?: boolean;
}

export interface AgentOutputSchema {
  type: "object";
  additionalProperties: false;
  properties: Record<
    string,
    { type: string; items?: { type: string }; enum?: string[] }
  >;
  required: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeSchemaType(name: string, type: string): string {
  const article = /^[aeiou]/.test(type) ? "an" : "a";
  return `${name} must be ${article} ${type}`;
}

export function validateAgentOutput(
  value: unknown,
  schema: AgentOutputSchema,
): AgentOutput {
  if (!isRecord(value)) {
    throw new Error("expected an object");
  }

  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties));
    const extraKey = Object.keys(value).find((key) => !allowed.has(key));
    if (extraKey) {
      throw new Error(`unexpected property ${extraKey}`);
    }
  }

  for (const name of schema.required) {
    if (!(name in value)) {
      throw new Error(`${name} is required`);
    }
  }

  for (const [name, property] of Object.entries(schema.properties)) {
    if (!(name in value)) {
      continue;
    }
    const propertyValue = value[name];

    if (property.type === "array") {
      if (
        !Array.isArray(propertyValue) ||
        property.items?.type !== "string" ||
        !propertyValue.every((item) => typeof item === "string")
      ) {
        throw new Error(`${name} must be an array of strings`);
      }
      continue;
    }

    if (typeof propertyValue !== property.type) {
      throw new Error(describeSchemaType(name, property.type));
    }

    if (property.enum && !property.enum.includes(propertyValue as string)) {
      throw new Error(
        `${name} must be one of ${property.enum.map((item) => JSON.stringify(item)).join(", ")}`,
      );
    }
  }

  return value as unknown as AgentOutput;
}

export interface AgentOutputCommitField {
  name: string;
  allowed?: string[];
}

// Codex's --output-schema enforces OpenAI strict mode, which requires every
// key in `properties` to also appear in `required` when additionalProperties
// is false. So include should_fully_stop only when the run actually uses it.
export function buildAgentOutputSchema(opts: {
  includeStopField: boolean;
  commitFields?: AgentOutputCommitField[];
}): AgentOutputSchema {
  const properties: AgentOutputSchema["properties"] = {
    success: { type: "boolean" },
    summary: { type: "string" },
    key_changes_made: { type: "array", items: { type: "string" } },
    key_learnings: { type: "array", items: { type: "string" } },
  };
  const required = ["success", "summary", "key_changes_made", "key_learnings"];
  for (const field of opts.commitFields ?? []) {
    properties[field.name] = {
      type: "string",
      ...(field.allowed === undefined ? {} : { enum: field.allowed }),
    };
    required.push(field.name);
  }
  if (opts.includeStopField) {
    properties.should_fully_stop = { type: "boolean" };
    required.push("should_fully_stop");
  }
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface AgentResult {
  output: AgentOutput;
  usage: TokenUsage;
}

export class PermanentAgentError extends Error {
  detail: string;

  constructor(message: string, detail: string) {
    super(message, { cause: detail });
    this.name = "PermanentAgentError";
    this.detail = detail;
  }
}

export type OnUsage = (usage: TokenUsage) => void;

export type OnMessage = (text: string) => void;

export interface AgentRunOptions {
  onUsage?: OnUsage;
  onMessage?: OnMessage;
  signal?: AbortSignal;
  logPath?: string;
}

export interface Agent {
  name: string;
  close?(): Promise<void> | void;
  run(
    prompt: string,
    cwd: string,
    options?: AgentRunOptions,
  ): Promise<AgentResult>;
}
