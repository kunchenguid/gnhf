import type { Agent } from "./types.js";
import type { RunInfo } from "../run.js";
import { ClaudeAgent } from "./claude.js";
import { CodexAgent } from "./codex.js";
import { RovoDevAgent } from "./rovodev.js";

export function createAgent(
  name: "claude" | "codex" | "rovodev",
  runInfo: RunInfo,
): Agent {
  switch (name) {
    case "claude":
      return new ClaudeAgent();
    case "codex":
      return new CodexAgent(runInfo.schemaPath);
    case "rovodev":
      return new RovoDevAgent(runInfo.schemaPath);
  }
}
