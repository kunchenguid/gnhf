import { join } from "node:path";
import {
  buildAgentOutputSchema,
  type Agent,
  type AgentOutputCommitField,
} from "./types.js";
import { getAcpTarget, isAcpSpec, type AgentSpec } from "../config.js";
import type { RunInfo } from "../run.js";
import { AcpAgent } from "./acp.js";
import { ClaudeAgent } from "./claude.js";
import { CopilotAgent } from "./copilot.js";
import { CodexAgent } from "./codex.js";
import { OpenCodeAgent } from "./opencode.js";
import { PiAgent } from "./pi.js";
import { RovoDevAgent } from "./rovodev.js";

export interface CreateAgentOptions {
  includeStopField: boolean;
  commitFields?: AgentOutputCommitField[];
}

export function createAgent(
  spec: AgentSpec,
  runInfo: RunInfo,
  pathOverride: string | undefined,
  agentArgsOverride: string[] | undefined,
  options: CreateAgentOptions,
): Agent {
  const schema = buildAgentOutputSchema({
    includeStopField: options.includeStopField,
    commitFields: options.commitFields,
  });

  if (isAcpSpec(spec)) {
    return new AcpAgent({
      target: getAcpTarget(spec),
      schema,
      runId: runInfo.runId,
      sessionStateDir: join(runInfo.runDir, "acp-sessions"),
    });
  }

  const name = spec;
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
    case "pi":
      return new PiAgent({
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
