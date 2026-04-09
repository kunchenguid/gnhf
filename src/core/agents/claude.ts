import { execFileSync, spawn } from "node:child_process";
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

interface ClaudeAgentDeps {
  bin?: string;
  extraArgs?: string[];
  platform?: NodeJS.Platform;
}

function shouldUseWindowsShell(
  bin: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform !== "win32") {
    return false;
  }

  if (/\.(cmd|bat)$/i.test(bin)) {
    return true;
  }

  if (/[\\/]/.test(bin)) {
    return false;
  }

  try {
    const resolved = execFileSync("where", [bin], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const firstMatch = resolved
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return firstMatch ? /\.(cmd|bat)$/i.test(firstMatch) : false;
  } catch {
    return false;
  }
}

function terminateClaudeProcess(
  child: ReturnType<typeof spawn>,
  platform: NodeJS.Platform,
): void {
  if (platform === "win32" && child.pid) {
    try {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
        stdio: "ignore",
      });
    } catch {
      // Best-effort: the process may have already exited.
    }
    return;
  }

  child.kill("SIGTERM");
}

function buildClaudeArgs(prompt: string, extraArgs?: string[]): string[] {
  const userArgs = extraArgs ?? [];
  const userSpecifiedPermissionMode = userArgs.some(
    (arg) =>
      arg === "--dangerously-skip-permissions" ||
      arg === "--permission-mode" ||
      arg.startsWith("--permission-mode=") ||
      arg === "--permission-prompt-tool" ||
      arg.startsWith("--permission-prompt-tool="),
  );

  return [
    ...userArgs,
    "-p",
    prompt,
    "--verbose",
    "--output-format",
    "stream-json",
    "--json-schema",
    JSON.stringify(AGENT_OUTPUT_SCHEMA),
    ...(userSpecifiedPermissionMode ? [] : ["--dangerously-skip-permissions"]),
  ];
}

export class ClaudeAgent implements Agent {
  name = "claude";

  private bin: string;
  private extraArgs?: string[];
  private platform: NodeJS.Platform;

  constructor(binOrDeps: string | ClaudeAgentDeps = {}) {
    const deps = typeof binOrDeps === "string" ? { bin: binOrDeps } : binOrDeps;
    this.bin = deps.bin ?? "claude";
    this.extraArgs = deps.extraArgs;
    this.platform = deps.platform ?? process.platform;
  }

  run(
    prompt: string,
    cwd: string,
    options?: AgentRunOptions,
  ): Promise<AgentResult> {
    const { onUsage, onMessage, signal, logPath } = options ?? {};

    return new Promise((resolve, reject) => {
      const logStream = logPath ? createWriteStream(logPath) : null;

      const child = spawn(this.bin, buildClaudeArgs(prompt, this.extraArgs), {
        cwd,
        shell: shouldUseWindowsShell(this.bin, this.platform),
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });

      if (
        setupAbortHandler(signal, child, reject, () =>
          terminateClaudeProcess(child, this.platform),
        )
      ) {
        return;
      }

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
