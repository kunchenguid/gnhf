import { buildAgentOutputSchema, type Agent } from "./types.js";
import type { AgentName } from "../config.js";
import type { RunInfo } from "../run.js";
import { ClaudeAgent } from "./claude.js";
import { CopilotAgent } from "./copilot.js";
import { CodexAgent } from "./codex.js";
import { OpenCodeAgent } from "./opencode.js";
import { RovoDevAgent } from "./rovodev.js";

export interface CreateAgentOptions {
  includeStopField: boolean;
}

export function createAgent(
  name: AgentName,
  runInfo: RunInfo,
  pathOverride: string | undefined,
  agentArgsOverride: string[] | undefined,
  options: CreateAgentOptions,
): Agent {
  const schema = buildAgentOutputSchema({
    includeStopField: options.includeStopField,
  });
  switch (name) {
    case "claude":
      return new ClaudeAgent({
        bin: pathOverride,
        extraArgs: agentArgsOverride,
        schema,
      });
    case "codex":
      return new CodexAgent(runInfo.schemaPath, {
        bin: pathOverride,
        extraArgs: agentArgsOverride,
      });
    case "copilot":
      return new CopilotAgent({
        bin: pathOverride,
        extraArgs: agentArgsOverride,
        schema,
      });
    case "opencode":
      return new OpenCodeAgent({
        bin: pathOverride,
        extraArgs: agentArgsOverride,
        schema,
      });
    case "rovodev":
      return new RovoDevAgent(runInfo.schemaPath, {
        bin: pathOverride,
        extraArgs: agentArgsOverride,
      });
  }
}
