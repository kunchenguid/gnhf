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
  properties: Record<string, { type: string; items?: { type: string } }>;
  required: string[];
}

// Codex's --output-schema enforces OpenAI strict mode, which requires every
// key in `properties` to also appear in `required` when additionalProperties
// is false. So include should_fully_stop only when the run actually uses it.
export function buildAgentOutputSchema(opts: {
  includeStopField: boolean;
}): AgentOutputSchema {
  const properties: AgentOutputSchema["properties"] = {
    success: { type: "boolean" },
    summary: { type: "string" },
    key_changes_made: { type: "array", items: { type: "string" } },
    key_learnings: { type: "array", items: { type: "string" } },
  };
  const required = ["success", "summary", "key_changes_made", "key_learnings"];
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
