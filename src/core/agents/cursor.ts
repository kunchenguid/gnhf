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
} from "./types.js";
import { parseAgentJson } from "./json-extract.js";
import {
  parseJSONLStream,
  setupAbortHandler,
  setupChildProcessHandlers,
} from "./stream-utils.js";

interface CursorAssistantEvent {
  type: "assistant";
  message: {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
  timestamp_ms?: number;
  model_call_id?: string;
  session_id?: string;
}

interface CursorThinkingEvent {
  type: "thinking";
  subtype?: string;
  text?: string;
  timestamp_ms?: number;
  session_id?: string;
}

interface CursorToolCallEvent {
  type: "tool_call";
  subtype: "started" | "completed";
  call_id?: string;
  session_id?: string;
}

interface CursorResultUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

interface CursorResultEvent {
  type: "result";
  subtype: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  usage?: CursorResultUsage;
}

type CursorEvent =
  | CursorAssistantEvent
  | CursorThinkingEvent
  | CursorToolCallEvent
  | CursorResultEvent
  | { type: string };

// Rough character-to-token heuristic. cursor-agent only emits authoritative
// token usage on the terminal `result` event (and not always), so this gives
// the renderer a non-zero, roughly proportional number while the run is in
// flight. Replaced with real numbers as soon as the result event arrives.
function estimateTokens(charCount: number): number {
  if (charCount <= 0) return 0;
  return Math.ceil(charCount / 4);
}

// Per-tool-call input-cost heuristic. Each tool result (file contents,
// shell output, edit confirmation) feeds back into the model's context as
// input on the next round, so the tool-call count dominates real input
// usage in practice. 2000 covers a mix of large reads and small bash/edit
// invocations - matches the heuristic ACP uses for the same reason.
const ESTIMATED_TOKENS_PER_TOOL_CALL = 2000;

interface CursorAgentDeps {
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

function terminateCursorProcess(
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
      arg === "--force" ||
      arg === "-f" ||
      arg === "--yolo" ||
      arg === "--sandbox" ||
      arg.startsWith("--sandbox=") ||
      arg === "--trust",
  );
}

function buildCursorPrompt(prompt: string, schema: AgentOutputSchema): string {
  return `${prompt}

## gnhf final output contract

When the iteration is complete, your final assistant message must be a single JSON object that matches this JSON Schema:

\`\`\`json
${JSON.stringify(schema, null, 2)}
\`\`\`

Return only the JSON object as your final answer. Do not wrap it in Markdown fences. Do not include explanatory prose before or after the JSON.`;
}

function buildCursorArgs(
  prompt: string,
  schema: AgentOutputSchema,
  extraArgs?: string[],
): string[] {
  const userArgs = extraArgs ?? [];

  return [
    ...userArgs,
    "-p",
    buildCursorPrompt(prompt, schema),
    "--output-format",
    "stream-json",
    ...(userSpecifiedPermissionMode(userArgs) ? [] : ["--force", "--trust"]),
  ];
}

function textFromAssistantEvent(event: CursorAssistantEvent): string | null {
  const content = event.message?.content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((block) => (block && typeof block.text === "string" ? block.text : ""))
    .filter((text) => text.length > 0);
  if (parts.length === 0) return null;
  return parts.join("");
}

function readResultUsage(
  usage: CursorResultUsage | undefined,
): TokenUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens =
    typeof usage.inputTokens === "number" ? usage.inputTokens : undefined;
  const outputTokens =
    typeof usage.outputTokens === "number" ? usage.outputTokens : undefined;
  const cacheReadTokens =
    typeof usage.cacheReadTokens === "number"
      ? usage.cacheReadTokens
      : undefined;
  const cacheCreationTokens =
    typeof usage.cacheWriteTokens === "number"
      ? usage.cacheWriteTokens
      : undefined;

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheCreationTokens === undefined
  ) {
    return null;
  }

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheCreationTokens: cacheCreationTokens ?? 0,
  };
}

// cursor-agent surfaces a handful of stderr lines that will never resolve on
// retry: an invalid `--model` value (`AI Model Not Found Model name is not
// valid: "..."`) or rejection of a known-but-unavailable model id (`Cannot use
// this model: ...`). Treat those as permanent so the orchestrator aborts the
// run instead of spinning through the retry budget. Other failures (network
// blips, auth glitches) remain retryable.
function isPermanentCursorError(stderr: string): boolean {
  return (
    /AI\s+Model\s+Not\s+Found/i.test(stderr) ||
    /Model\s+name\s+is\s+not\s+valid/i.test(stderr) ||
    /Cannot\s+use\s+this\s+model/i.test(stderr)
  );
}

function classifyCursorExit(
  stderr: string,
  defaultMessage: string,
): Error | null {
  if (isPermanentCursorError(stderr)) {
    return new PermanentAgentError(
      "cursor: invalid model name - see gnhf.log",
      defaultMessage,
    );
  }
  return null;
}

function parseCursorOutput(
  text: string,
  schema: AgentOutputSchema,
): AgentOutput {
  const parsed = parseAgentJson(text, (value) => {
    try {
      validateAgentOutput(value, schema);
      return true;
    } catch {
      return false;
    }
  });
  if (parsed !== null) {
    return validateAgentOutput(parsed, schema);
  }

  const fallbackParsed = parseAgentJson(text);
  if (fallbackParsed !== null) {
    return validateAgentOutput(fallbackParsed, schema);
  }

  throw new SyntaxError(
    "cursor output did not contain a parseable JSON object",
  );
}

export class CursorAgent implements Agent {
  name = "cursor";

  private bin: string;
  private extraArgs?: string[];
  private platform: NodeJS.Platform;
  private schema: AgentOutputSchema;

  constructor(binOrDeps: string | CursorAgentDeps = {}) {
    const deps = typeof binOrDeps === "string" ? { bin: binOrDeps } : binOrDeps;
    this.bin = deps.bin ?? "cursor-agent";
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
    const { onMessage, onUsage, signal, logPath } = options ?? {};

    return new Promise((resolve, reject) => {
      const logStream = logPath ? createWriteStream(logPath) : null;

      const child = spawn(
        this.bin,
        buildCursorArgs(prompt, this.schema, this.extraArgs),
        {
          cwd,
          shell: shouldUseWindowsShell(this.bin, this.platform),
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        },
      );

      if (
        setupAbortHandler(signal, child, reject, () =>
          terminateCursorProcess(child, this.platform),
        )
      ) {
        return;
      }

      let assistantText = "";
      let resultText: string | null = null;
      let resultErrored = false;
      // Tracks whether we have authoritative usage numbers from a terminal
      // `result.usage` event. Until then, onUsage callbacks carry running
      // heuristic estimates so the renderer is never stuck at zero, but we
      // do not flag them estimated:true so the display matches the other
      // native agents that report whatever their CLI gives them.
      let authoritativeUsage: TokenUsage | null = null;
      let agentOutputChars = 0;
      let toolCallCount = 0;
      const promptTokenEstimate = estimateTokens(
        buildCursorPrompt(prompt, this.schema).length,
      );

      const emitUsage = () => {
        if (authoritativeUsage) {
          onUsage?.({ ...authoritativeUsage });
          return;
        }
        onUsage?.({
          inputTokens:
            promptTokenEstimate +
            toolCallCount * ESTIMATED_TOKENS_PER_TOOL_CALL,
          outputTokens: estimateTokens(agentOutputChars),
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        });
      };

      // Seed the renderer with the prompt-only estimate so token counters
      // are non-zero as soon as the iteration starts, before any deltas.
      emitUsage();

      parseJSONLStream<CursorEvent>(child.stdout!, logStream, (event) => {
        if (event.type === "assistant") {
          const text = textFromAssistantEvent(event as CursorAssistantEvent);
          if (text !== null) {
            assistantText += text;
            agentOutputChars += text.length;
            const visible = text.trim();
            if (visible) onMessage?.(visible);
            emitUsage();
          }
          return;
        }

        if (event.type === "thinking") {
          const next = event as CursorThinkingEvent;
          // cursor-agent streams reasoning as `thinking` deltas. Counting
          // their characters toward output tokens keeps the renderer moving
          // during long pre-tool-call thinking phases instead of frozen at
          // the prompt-only estimate.
          if (next.subtype === "delta" && typeof next.text === "string") {
            agentOutputChars += next.text.length;
            emitUsage();
          }
          return;
        }

        if (event.type === "tool_call") {
          const next = event as CursorToolCallEvent;
          if (next.subtype === "started") {
            toolCallCount += 1;
            emitUsage();
          }
          return;
        }

        if (event.type === "result") {
          const next = event as CursorResultEvent;
          if (next.is_error || next.subtype !== "success") {
            resultErrored = true;
            return;
          }
          if (typeof next.result === "string") {
            resultText = next.result;
          }
          const usage = readResultUsage(next.usage);
          if (usage) {
            authoritativeUsage = usage;
          }
          emitUsage();
        }
      });

      setupChildProcessHandlers(
        child,
        "cursor",
        logStream,
        reject,
        () => {
          if (resultErrored) {
            reject(new Error("cursor reported error"));
            return;
          }

          const candidate = resultText ?? (assistantText || null);
          if (!candidate) {
            reject(new Error("cursor returned no agent message"));
            return;
          }

          try {
            const output = parseCursorOutput(candidate, this.schema);
            const usage: TokenUsage = authoritativeUsage
              ? { ...authoritativeUsage }
              : {
                  inputTokens:
                    promptTokenEstimate +
                    toolCallCount * ESTIMATED_TOKENS_PER_TOOL_CALL,
                  outputTokens: estimateTokens(agentOutputChars),
                  cacheReadTokens: 0,
                  cacheCreationTokens: 0,
                };
            resolve({ output, usage });
          } catch (err) {
            reject(
              new Error(
                `Failed to parse cursor output: ${err instanceof Error ? err.message : err}`,
              ),
            );
          }
        },
        classifyCursorExit,
      );
    });
  }
}
