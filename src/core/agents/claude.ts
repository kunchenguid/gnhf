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
    id?: string;
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

function toTokenUsage(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): TokenUsage {
  return {
    inputTokens:
      (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function isSameUsage(a: TokenUsage, b: TokenUsage): boolean {
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheCreationTokens === b.cacheCreationTokens
  );
}

function extendsUsage(next: TokenUsage, previous: TokenUsage): boolean {
  return (
    next.inputTokens >= previous.inputTokens &&
    next.outputTokens >= previous.outputTokens &&
    next.cacheReadTokens >= previous.cacheReadTokens &&
    next.cacheCreationTokens >= previous.cacheCreationTokens &&
    !isSameUsage(next, previous)
  );
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
      const usageByMessageId = new Map<string, TokenUsage>();
      let anonymousAssistantCount = 0;
      let lastAnonymousAssistantId: string | null = null;
      let lastAnonymousAssistantUsage: TokenUsage | null = null;
      let pendingAnonymousAssistantUsage: TokenUsage | null = null;

      parseJSONLStream<ClaudeEvent>(child.stdout!, logStream, (event) => {
        if (event.type === "assistant") {
          const msg = (event as ClaudeAssistantEvent).message;
          const nextUsage = toTokenUsage(msg.usage);
          let messageId = msg.id;
          let previousUsage: TokenUsage | undefined;

          if (messageId) {
            previousUsage = usageByMessageId.get(messageId);
            lastAnonymousAssistantId = null;
            lastAnonymousAssistantUsage = null;
            pendingAnonymousAssistantUsage = null;
          } else if (
            pendingAnonymousAssistantUsage &&
            extendsUsage(nextUsage, pendingAnonymousAssistantUsage)
          ) {
            messageId = `assistant-${anonymousAssistantCount++}`;
            previousUsage = pendingAnonymousAssistantUsage;
            cumulative.inputTokens +=
              pendingAnonymousAssistantUsage.inputTokens;
            cumulative.outputTokens +=
              pendingAnonymousAssistantUsage.outputTokens;
            cumulative.cacheReadTokens +=
              pendingAnonymousAssistantUsage.cacheReadTokens;
            cumulative.cacheCreationTokens +=
              pendingAnonymousAssistantUsage.cacheCreationTokens;
            usageByMessageId.set(messageId, pendingAnonymousAssistantUsage);
            pendingAnonymousAssistantUsage = null;
            lastAnonymousAssistantId = messageId;
            lastAnonymousAssistantUsage = nextUsage;
          } else if (
            lastAnonymousAssistantId &&
            lastAnonymousAssistantUsage &&
            extendsUsage(nextUsage, lastAnonymousAssistantUsage)
          ) {
            messageId = lastAnonymousAssistantId;
            previousUsage = usageByMessageId.get(messageId);
            pendingAnonymousAssistantUsage = null;
            lastAnonymousAssistantUsage = nextUsage;
          } else if (
            lastAnonymousAssistantId &&
            lastAnonymousAssistantUsage &&
            isSameUsage(nextUsage, lastAnonymousAssistantUsage)
          ) {
            messageId = lastAnonymousAssistantId;
            previousUsage = usageByMessageId.get(messageId);
            pendingAnonymousAssistantUsage ??= nextUsage;
          } else {
            messageId = `assistant-${anonymousAssistantCount++}`;
            pendingAnonymousAssistantUsage = null;
            lastAnonymousAssistantId = messageId;
            lastAnonymousAssistantUsage = nextUsage;
          }

          if (previousUsage) {
            cumulative.inputTokens +=
              nextUsage.inputTokens - previousUsage.inputTokens;
            cumulative.outputTokens +=
              nextUsage.outputTokens - previousUsage.outputTokens;
            cumulative.cacheReadTokens +=
              nextUsage.cacheReadTokens - previousUsage.cacheReadTokens;
            cumulative.cacheCreationTokens +=
              nextUsage.cacheCreationTokens - previousUsage.cacheCreationTokens;
          } else {
            cumulative.inputTokens += nextUsage.inputTokens;
            cumulative.outputTokens += nextUsage.outputTokens;
            cumulative.cacheReadTokens += nextUsage.cacheReadTokens;
            cumulative.cacheCreationTokens += nextUsage.cacheCreationTokens;
          }

          usageByMessageId.set(messageId, nextUsage);
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
        const usage = toTokenUsage(resultEvent.usage);

        onUsage?.(usage);
        resolve({ output, usage });
      });
    });
  }
}
