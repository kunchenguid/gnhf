import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  buildAgentOutputSchema,
  validateAgentOutput,
  type Agent,
  type AgentOutputSchema,
  type AgentResult,
  type AgentRunOptions,
  type TokenUsage,
} from "./types.js";
import { parseAgentJson } from "./json-extract.js";
import {
  parseJSONLStream,
  setupAbortHandler,
  setupChildProcessHandlers,
} from "./stream-utils.js";

interface GrokTextEvent {
  type: "text";
  data?: string;
}

interface GrokEndEvent {
  type: "end";
  stopReason?: string;
  usage?: {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
    reasoning_tokens?: number;
    total_tokens?: number;
  };
  structuredOutput?: unknown;
}

type GrokEvent = GrokTextEvent | GrokEndEvent | { type: string };

interface GrokAgentDeps {
  bin?: string;
  extraArgs?: string[];
  platform?: NodeJS.Platform;
  schema?: AgentOutputSchema;
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

function terminateGrokProcess(
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

function userSpecifiedPermissionMode(userArgs: string[]): boolean {
  return userArgs.some(
    (arg) =>
      arg === "--always-approve" ||
      arg === "--permission-mode" ||
      arg.startsWith("--permission-mode=") ||
      arg === "--allow" ||
      arg.startsWith("--allow=") ||
      arg === "--deny" ||
      arg.startsWith("--deny=") ||
      arg === "--disallowed-tools" ||
      arg.startsWith("--disallowed-tools=") ||
      arg === "--tools" ||
      arg.startsWith("--tools="),
  );
}

function buildGrokArgs(
  prompt: string,
  schema: AgentOutputSchema,
  extraArgs?: string[],
): string[] {
  const userArgs = extraArgs ?? [];

  return [
    ...userArgs,
    "-p",
    prompt,
    "--output-format",
    "streaming-json",
    "--json-schema",
    JSON.stringify(schema),
    ...(userSpecifiedPermissionMode(userArgs) ? [] : ["--always-approve"]),
  ];
}

function toTokenUsage(usage: GrokEndEvent["usage"] | undefined): TokenUsage {
  if (!usage) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
  }

  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  return {
    // Match Claude-style cumulative input accounting: billed/prompt tokens
    // include both fresh input and cache reads when both are reported.
    inputTokens: (usage.input_tokens ?? 0) + cacheReadTokens,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens,
    cacheCreationTokens: 0,
  };
}

export class GrokAgent implements Agent {
  name = "grok";

  private bin: string;
  private extraArgs?: string[];
  private platform: NodeJS.Platform;
  private schema: AgentOutputSchema;

  constructor(deps: GrokAgentDeps = {}) {
    this.bin = deps.bin ?? "grok";
    this.extraArgs = deps.extraArgs;
    this.platform = deps.platform ?? process.platform;
    this.schema =
      deps.schema ?? buildAgentOutputSchema({ includeStopField: false });
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
        buildGrokArgs(prompt, this.schema, this.extraArgs),
        {
          cwd,
          detached: this.platform !== "win32",
          shell: shouldUseWindowsShell(this.bin, this.platform),
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        },
      );

      if (
        setupAbortHandler(signal, child, reject, () =>
          terminateGrokProcess(child, this.platform),
        )
      ) {
        return;
      }

      let endEvent: GrokEndEvent | null = null;
      let textBuffer = "";

      parseJSONLStream<GrokEvent>(child.stdout!, logStream, (event) => {
        if (event.type === "text") {
          const data =
            "data" in event && typeof event.data === "string" ? event.data : "";
          if (!data) return;
          textBuffer += data;
          const visible = textBuffer.trim();
          if (visible) onMessage?.(visible);
          return;
        }

        if (event.type === "end") {
          endEvent = event as GrokEndEvent;
          const usage = toTokenUsage(endEvent.usage);
          onUsage?.(usage);
        }
      });

      setupChildProcessHandlers(child, "grok", logStream, reject, () => {
        if (!endEvent) {
          reject(new Error("grok returned no end event"));
          return;
        }

        if (
          endEvent.stopReason &&
          endEvent.stopReason !== "EndTurn" &&
          endEvent.stopReason !== "end_turn"
        ) {
          reject(
            new Error(
              `grok reported stopReason ${JSON.stringify(endEvent.stopReason)}`,
            ),
          );
          return;
        }

        const usage = toTokenUsage(endEvent.usage);

        let parsed: unknown;
        if (endEvent.structuredOutput !== undefined) {
          parsed = endEvent.structuredOutput;
        } else {
          const finalText = textBuffer.trim();
          if (!finalText) {
            reject(new Error("grok returned no structuredOutput or text"));
            return;
          }
          try {
            parsed = parseAgentJson(finalText);
          } catch (err) {
            reject(
              new Error(
                `Failed to parse grok output: ${err instanceof Error ? err.message : err}`,
              ),
            );
            return;
          }
        }

        try {
          const output = validateAgentOutput(parsed, this.schema);
          resolve({ output, usage });
        } catch (err) {
          reject(
            new Error(
              `Invalid grok output: ${err instanceof Error ? err.message : err}`,
            ),
          );
        }
      });
    });
  }
}
