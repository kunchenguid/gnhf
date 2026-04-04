import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  AGENT_OUTPUT_SCHEMA,
  type Agent,
  type AgentResult,
  type AgentOutput,
  type TokenUsage,
  type AgentRunOptions,
} from "./types.js";
import {
  parseJSONLStream,
  setupAbortHandler,
  setupChildProcessHandlers,
} from "./stream-utils.js";

interface ClaudeAssistantEvent {
  type: "assistant";
  message: {
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

interface ClaudeResultEvent {
  type: "result";
  subtype: string;
  is_error?: boolean;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    output_tokens: number;
  };
  structured_output: AgentOutput | null;
}

type ClaudeEvent = ClaudeAssistantEvent | ClaudeResultEvent | { type: string };

export class ClaudeAgent implements Agent {
  name = "claude";

  private bin: string;

  constructor(bin?: string) {
    this.bin = bin ?? "claude";
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
        this.bin,
        [
          "-p",
          prompt,
          "--verbose",
          "--output-format",
          "stream-json",
          "--json-schema",
          JSON.stringify(AGENT_OUTPUT_SCHEMA),
          "--dangerously-skip-permissions",
        ],
        { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env },
      );

      if (setupAbortHandler(signal, child, reject)) return;

      let resultEvent: ClaudeResultEvent | null = null;
      const cumulative: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };

      parseJSONLStream<ClaudeEvent>(child.stdout!, logStream, (event) => {
        if (event.type === "assistant") {
          const msg = (event as ClaudeAssistantEvent).message;
          cumulative.inputTokens +=
            (msg.usage.input_tokens ?? 0) +
            (msg.usage.cache_read_input_tokens ?? 0);
          cumulative.outputTokens += msg.usage.output_tokens ?? 0;
          cumulative.cacheReadTokens += msg.usage.cache_read_input_tokens ?? 0;
          cumulative.cacheCreationTokens +=
            msg.usage.cache_creation_input_tokens ?? 0;
          onUsage?.({ ...cumulative });

          if (onMessage) {
            const content = (msg as Record<string, unknown>).content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (
                  block?.type === "text" &&
                  typeof block.text === "string" &&
                  block.text.trim()
                ) {
                  onMessage(block.text.trim());
                }
              }
            }
          }
        }

        if (event.type === "result") {
          resultEvent = event as ClaudeResultEvent;
        }
      });

      setupChildProcessHandlers(child, "claude", logStream, reject, () => {
        if (!resultEvent) {
          reject(new Error("claude returned no result event"));
          return;
        }

        if (resultEvent.is_error || resultEvent.subtype !== "success") {
          reject(
            new Error(`claude reported error: ${JSON.stringify(resultEvent)}`),
          );
          return;
        }

        if (!resultEvent.structured_output) {
          reject(new Error("claude returned no structured_output"));
          return;
        }

        const output: AgentOutput = resultEvent.structured_output;
        const usage: TokenUsage = {
          inputTokens:
            (resultEvent.usage.input_tokens ?? 0) +
            (resultEvent.usage.cache_read_input_tokens ?? 0),
          outputTokens: resultEvent.usage.output_tokens ?? 0,
          cacheReadTokens: resultEvent.usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens:
            resultEvent.usage.cache_creation_input_tokens ?? 0,
        };

        onUsage?.(usage);
        resolve({ output, usage });
      });
    });
  }
}
