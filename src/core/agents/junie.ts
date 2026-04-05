import {
  AGENT_OUTPUT_SCHEMA,
  type AgentOutput,
  type TokenUsage,
} from "./types.js";
import { TextBasedAgent, type TextBasedAgentDeps } from "./text-based-agent.js";

const JSON_FENCE_RE = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/;
const TRAILING_JSON_RE = /\{[\s\S]*\}\s*$/;

function extractJson(text: string): string {
  const fenceMatch = text.match(JSON_FENCE_RE);
  if (fenceMatch) return fenceMatch[1];
  const trailingMatch = text.match(TRAILING_JSON_RE);
  if (trailingMatch) return trailingMatch[0];
  return text;
}

export class JunieAgent extends TextBasedAgent {
  name = "junie";

  constructor(deps: TextBasedAgentDeps = {}) {
    super("junie", deps);
  }

  protected buildArgs(prompt: string): string[] {
    const fullPrompt = [
      prompt,
      "",
      "When you finish, reply with only valid JSON.",
      "Do not wrap the JSON in markdown fences.",
      "Do not include any prose before or after the JSON.",
      `The JSON must match this schema exactly: ${JSON.stringify(AGENT_OUTPUT_SCHEMA)}`,
    ].join("\n");

    return ["--task", fullPrompt];
  }

  protected parseOutput(stdout: string): AgentOutput {
    const raw = stdout.trim();
    try {
      return JSON.parse(raw) as AgentOutput;
    } catch {
      const extracted = extractJson(raw);
      return JSON.parse(extracted) as AgentOutput;
    }
  }

  protected parseUsage(_stdout: string): TokenUsage {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
  }
}
