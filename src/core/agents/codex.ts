import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import type {
  Agent,
  AgentResult,
  AgentOutput,
  TokenUsage,
  AgentRunOptions,
} from "./types.js";
import {
  parseJSONLStream,
  setupAbortHandler,
  setupChildProcessHandlers,
} from "./stream-utils.js";

interface CodexItemCompleted {
  type: "item.completed";
  item: { type: string; text: string };
}

interface CodexTurnCompleted {
  type: "turn.completed";
  usage: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
  };
}

type CodexEvent = CodexItemCompleted | CodexTurnCompleted | { type: string };

export class CodexAgent implements Agent {
  name = "codex";

  private schemaPath: string;

  constructor(schemaPath: string) {
    this.schemaPath = schemaPath;
  }

  run(
    prompt: string,
    cwd: string,
    options?: AgentRunOptions,
  ): Promise<AgentResult> {
    const { onUsage, onMessage, signal, logPath } = options ?? {};

    return new Promise((resolve, reject) => {
      const logStream = logPath ? createWriteStream(logPath) : null;

      const child = spawn(
        "codex",
        [
          "exec",
          prompt,
          "--json",
          "--output-schema",
          this.schemaPath,
          "--dangerously-bypass-approvals-and-sandbox",
          "--color",
          "never",
        ],
        { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env },
      );

      if (setupAbortHandler(signal, child, reject)) return;

      let lastAgentMessage: string | null = null;
      const cumulative: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };

      parseJSONLStream<CodexEvent>(child.stdout!, logStream, (event) => {
        if (
          event.type === "item.completed" &&
          "item" in event &&
          (event as CodexItemCompleted).item.type === "agent_message"
        ) {
          lastAgentMessage = (event as CodexItemCompleted).item.text;
          onMessage?.(lastAgentMessage);
        }

        if (event.type === "turn.completed" && "usage" in event) {
          const u = (event as CodexTurnCompleted).usage;
          cumulative.inputTokens += u.input_tokens ?? 0;
          cumulative.outputTokens += u.output_tokens ?? 0;
          cumulative.cacheReadTokens += u.cached_input_tokens ?? 0;
          onUsage?.({ ...cumulative });
        }
      });

      setupChildProcessHandlers(child, "codex", logStream, reject, () => {
        if (!lastAgentMessage) {
          reject(new Error("codex returned no agent message"));
          return;
        }

        try {
          const output = JSON.parse(lastAgentMessage) as AgentOutput;
          resolve({ output, usage: cumulative });
        } catch (err) {
          reject(
            new Error(
              `Failed to parse codex output: ${err instanceof Error ? err.message : err}`,
            ),
          );
        }
      });
    });
  }
}
