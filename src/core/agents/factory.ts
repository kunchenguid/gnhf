import type { Agent } from "./types.js";
import type { RunInfo } from "../run.js";
import { ClaudeAgent } from "./claude.js";
import { CodexAgent } from "./codex.js";
import { OpenCodeAgent } from "./opencode.js";
import { RovoDevAgent } from "./rovodev.js";

export function createAgent(
  name: "claude" | "codex" | "rovodev" | "opencode",
  runInfo: RunInfo,
): Agent {
  switch (name) {
    case "claude":
      return new ClaudeAgent();
    case "codex":
      return new CodexAgent(runInfo.schemaPath);
    case "opencode":
      return new OpenCodeAgent();
    case "rovodev":
      return new RovoDevAgent(runInfo.schemaPath);
  }
}
