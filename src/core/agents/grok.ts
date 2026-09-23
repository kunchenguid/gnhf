import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  buildAgentOutputSchema,
  validateAgentOutput,
  type Agent,
  type AgentOutput,
  type AgentOutputSchema,
  type AgentResult,
  type AgentRunOptions,
  type TokenUsage,
  PermanentAgentError,
  RateLimitAgentError,
} from "./types.js";
import { shutdownChildProcess } from "./managed-process.js";
import {
  appendExitOutputTail,
  describeChildProcessExit,
  parseJSONLStream,
  setupAbortHandler,
} from "./stream-utils.js";

const DEFAULT_FINAL_RESULT_EXIT_GRACE_MS = 15_000;

interface GrokUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface GrokEndEvent {
  type: "end";
  stopReason?: string;
  usage?: GrokUsage;
  structuredOutput?: unknown;
}

// `streaming-json` emits one ACP session update per line. Text arrives as
// token-sized deltas, and each `usage` event covers a single model request.
type GrokEvent =
  | { type: "text"; data?: string }
  | { type: "thought"; data?: string }
  | { type: "tool_call" }
  | { type: "usage"; usage?: GrokUsage }
  | { type: "error"; message?: string }
  | GrokEndEvent
  | { type: string };

interface GrokAgentDeps {
  bin?: string;
  extraArgs?: string[];
  finalResultGraceMs?: number;
  model?: string;
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

  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // Fall back to the direct child if it was not started as a process group.
    }
  }

  child.kill("SIGTERM");
}

async function shutdownGrokProcess(
  child: ReturnType<typeof spawn>,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform === "win32") {
    terminateGrokProcess(child, platform);
    return;
  }

  await shutdownChildProcess(child, {
    detached: true,
  });
}

function isModelArg(arg: string, previous: string | undefined): boolean {
  return (
    arg === "-m" ||
    arg === "--model" ||
    arg.startsWith("--model=") ||
    previous === "-m" ||
    previous === "--model"
  );
}

function buildGrokArgs(
  prompt: string,
  schema: AgentOutputSchema,
  extraArgs?: string[],
  model?: string,
): string[] {
  const userArgs = (extraArgs ?? []).filter(
    (arg, index, args) =>
      model === undefined || !isModelArg(arg, args[index - 1]),
  );
  const userSpecifiedPermissionMode = userArgs.some(
    (arg) =>
      arg === "--always-approve" ||
      arg === "--yolo" ||
      arg === "--dangerously-skip-permissions" ||
      arg === "--permission-mode" ||
      arg.startsWith("--permission-mode="),
  );

  return [
    ...userArgs,
    ...(model === undefined ? [] : ["-m", model]),
    "-p",
    prompt,
    "--output-format",
    "streaming-json",
    "--json-schema",
    JSON.stringify(schema),
    ...(userSpecifiedPermissionMode ? [] : ["--always-approve"]),
  ];
}

function toTokenUsage(usage: GrokUsage): TokenUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Classify grok's own error text. Signed-out and billing failures need a
 * human, so retrying only burns the consecutive-failure budget. Grok never
 * reports a reset time, so plan limits wait on the orchestrator's fallback.
 */
function classifyGrokFailure(errorOutput: string, detail: string): Error {
  if (/not signed in|invalid api key/i.test(errorOutput)) {
    return new PermanentAgentError(
      "grok is not authenticated - run `grok login` or set a valid XAI_API_KEY",
      detail,
    );
  }
  if (
    /out of credits|spending limit|credit limit|free usage limit|usage balance exhausted/i.test(
      errorOutput,
    )
  ) {
    return new PermanentAgentError(
      "grok is out of credits or over its spending limit - see gnhf.log",
      detail,
    );
  }
  if (/rate limit|too many requests|weekly limit/i.test(errorOutput)) {
    return new RateLimitAgentError("grok usage limit reached", detail, null);
  }
  return new Error(detail);
}

export class GrokAgent implements Agent {
  name = "grok";

  private bin: string;
  private extraArgs?: string[];
  private finalResultGraceMs: number;
  private model?: string;
  private platform: NodeJS.Platform;
  private schema: AgentOutputSchema;

  constructor(deps: GrokAgentDeps = {}) {
    this.bin = deps.bin ?? "grok";
    this.extraArgs = deps.extraArgs;
    this.finalResultGraceMs =
      deps.finalResultGraceMs ?? DEFAULT_FINAL_RESULT_EXIT_GRACE_MS;
    this.model = deps.model;
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
        buildGrokArgs(prompt, this.schema, this.extraArgs, this.model),
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
      let pendingText = "";
      const errorMessages: string[] = [];
      let finalResultCleanupTimer: ReturnType<typeof setTimeout> | null = null;
      let closedAfterFinalCleanup = false;
      let stderr = "";
      let stdoutTail = "";
      const cumulative: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };

      const flushPendingText = () => {
        const text = pendingText.trim();
        pendingText = "";
        if (text) onMessage?.(text);
      };

      child.stderr!.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.stdout!.on("data", (data: Buffer) => {
        stdoutTail = appendExitOutputTail(stdoutTail, data.toString());
      });

      child.on("error", (err) => {
        reject(new Error(`Failed to spawn grok: ${err.message}`));
      });

      parseJSONLStream<GrokEvent>(child.stdout!, logStream, (event) => {
        switch (event.type) {
          case "text": {
            const { data } = event as { data?: string };
            if (typeof data === "string") pendingText += data;
            return;
          }
          case "usage": {
            const { usage } = event as { usage?: GrokUsage };
            if (!usage) return;
            const next = toTokenUsage(usage);
            cumulative.inputTokens += next.inputTokens;
            cumulative.outputTokens += next.outputTokens;
            cumulative.cacheReadTokens += next.cacheReadTokens;
            cumulative.cacheCreationTokens += next.cacheCreationTokens;
            onUsage?.({ ...cumulative });
            return;
          }
          case "error": {
            flushPendingText();
            const { message } = event as { message?: string };
            if (typeof message === "string" && message.trim()) {
              errorMessages.push(message.trim());
            }
            return;
          }
          case "end": {
            flushPendingText();
            endEvent = event as GrokEndEvent;
            if (finalResultCleanupTimer) {
              clearTimeout(finalResultCleanupTimer);
            }
            finalResultCleanupTimer = setTimeout(() => {
              closedAfterFinalCleanup = true;
              void shutdownGrokProcess(child, this.platform);
            }, this.finalResultGraceMs);
            return;
          }
          default:
            flushPendingText();
        }
      });

      child.on("close", (code) => {
        if (finalResultCleanupTimer) {
          clearTimeout(finalResultCleanupTimer);
        }
        logStream?.end();
        flushPendingText();

        if (code !== 0 && !closedAfterFinalCleanup) {
          const failure = describeChildProcessExit(
            "grok",
            code,
            stdoutTail,
            stderr,
          );
          reject(classifyGrokFailure(failure.errorOutput, failure.detail));
          return;
        }

        const terminalEndEvent = endEvent as GrokEndEvent | null;
        if (!terminalEndEvent) {
          const detail =
            errorMessages.length > 0
              ? `grok reported error: ${errorMessages.join("\n")}`
              : "grok returned no end event";
          reject(classifyGrokFailure(errorMessages.join("\n"), detail));
          return;
        }

        if (terminalEndEvent.stopReason !== "end_turn") {
          reject(
            new Error(
              `grok stopped with reason ${terminalEndEvent.stopReason ?? "unknown"}`,
            ),
          );
          return;
        }

        if (!terminalEndEvent.structuredOutput) {
          reject(new Error("grok returned no structuredOutput"));
          return;
        }

        let output: AgentOutput;
        try {
          output = validateAgentOutput(
            terminalEndEvent.structuredOutput,
            this.schema,
          );
        } catch (err) {
          reject(
            new Error(
              `Invalid grok structuredOutput: ${err instanceof Error ? err.message : err}`,
            ),
          );
          return;
        }

        const usage = terminalEndEvent.usage
          ? toTokenUsage(terminalEndEvent.usage)
          : { ...cumulative };
        onUsage?.(usage);
        resolve({ output, usage });
      });
    });
  }
}
