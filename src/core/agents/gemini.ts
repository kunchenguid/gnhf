import {
  AGENT_OUTPUT_SCHEMA,
  type AgentOutput,
  type TokenUsage,
} from "./types.js";
import { TextBasedAgent, type TextBasedAgentDeps } from "./text-based-agent.js";
import { extractJson } from "./json-utils.js";

export class GeminiAgent extends TextBasedAgent {
  name = "gemini";

  constructor(deps: TextBasedAgentDeps = {}) {
    super("gemini", deps);
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

    return ["-p", fullPrompt, "--output-format", "json"];
  }

  protected parseOutput(stdout: string): AgentOutput {
    let raw = stdout.trim();

    try {
      const wrapper = JSON.parse(raw) as { response?: string };
      if (wrapper.response) {
        raw = wrapper.response;
      }
    } catch {
      // Not a wrapper object, try to extract JSON from the raw text
    }

    try {
      return JSON.parse(raw) as AgentOutput;
    } catch {
      const extracted = extractJson(raw);
      return JSON.parse(extracted) as AgentOutput;
    }
  }

  protected parseUsage(_stdout: string): TokenUsage {
    // TODO: Extract token usage from Gemini CLI output if available
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
  }
}
