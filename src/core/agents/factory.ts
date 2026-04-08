import type { Agent } from "./types.js";
import type { AgentName } from "../config.js";
import type { RunInfo } from "../run.js";
import { ClaudeAgent } from "./claude.js";
import { CodexAgent } from "./codex.js";
import { OpenCodeAgent } from "./opencode.js";
import { RovoDevAgent } from "./rovodev.js";

export function createAgent(
  name: AgentName,
  runInfo: RunInfo,
  pathOverride?: string,
  agentArgsOverride?: string[],
): Agent {
  switch (name) {
    case "claude":
      return new ClaudeAgent({
        bin: pathOverride,
        extraArgs: agentArgsOverride,
      });
    case "codex":
      return new CodexAgent(runInfo.schemaPath, {
        bin: pathOverride,
        extraArgs: agentArgsOverride,
      });
    case "opencode":
      return new OpenCodeAgent({
        bin: pathOverride,
        extraArgs: agentArgsOverride,
      });
    case "rovodev":
      return new RovoDevAgent(runInfo.schemaPath, {
        bin: pathOverride,
        extraArgs: agentArgsOverride,
      });
  }
}
