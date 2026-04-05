import type { Agent } from "./types.js";
import type { AgentName } from "../config.js";
import type { RunInfo } from "../run.js";
import { ClaudeAgent } from "./claude.js";
import { CodexAgent } from "./codex.js";
import { OpenCodeAgent } from "./opencode.js";
import { RovoDevAgent } from "./rovodev.js";
import { JulesAgent } from "./jules.js";
import { AsyncAgentAdapter } from "./async-adapter.js";

export function createAgent(
  name: AgentName,
  runInfo: RunInfo,
  pathOverride?: string,
): Agent {
  switch (name) {
    case "claude":
      return new ClaudeAgent(pathOverride);
    case "codex":
      return new CodexAgent(runInfo.schemaPath, pathOverride);
    case "opencode":
      return new OpenCodeAgent({ bin: pathOverride });
    case "rovodev":
      return new RovoDevAgent(runInfo.schemaPath, { bin: pathOverride });
    case "jules": {
      const julesAgent = new JulesAgent({
        bin: pathOverride,
        platform: process.platform,
      });
      return new AsyncAgentAdapter(julesAgent, {
        pollIntervalMs: 30_000,
        timeoutMs: 60 * 60 * 1000,
      });
    }
  }
}
