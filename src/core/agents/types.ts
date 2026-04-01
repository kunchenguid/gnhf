export interface AgentOutput {
  success: boolean;
  summary: string;
  key_changes_made: string[];
  key_learnings: string[];
}

export const AGENT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    success: { type: "boolean" },
    summary: { type: "string" },
    key_changes_made: { type: "array", items: { type: "string" } },
    key_learnings: { type: "array", items: { type: "string" } },
  },
  required: ["success", "summary", "key_changes_made", "key_learnings"],
} as const;

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
