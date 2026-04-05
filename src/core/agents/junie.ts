import {
  AGENT_OUTPUT_SCHEMA,
  type AgentOutput,
  type TokenUsage,
} from "./types.js";
import { TextBasedAgent, type TextBasedAgentDeps } from "./text-based-agent.js";
import { extractJson } from "./json-utils.js";

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
    // TODO: Extract token usage from Junie CLI output if available
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
  }
}
