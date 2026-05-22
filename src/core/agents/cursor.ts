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

type CursorEvent = CursorAssistantEvent | CursorResultEvent | { type: string };

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

      let lastAssistantText: string | null = null;
      let resultText: string | null = null;
      let resultErrored = false;
      // cursor-agent reports per-run usage only on the terminal result event,
      // so we start at zero and overwrite once we see the result.
      const cumulative: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };

      parseJSONLStream<CursorEvent>(child.stdout!, logStream, (event) => {
        if (event.type === "assistant") {
          const text = textFromAssistantEvent(event as CursorAssistantEvent);
          if (text !== null) {
            lastAssistantText = text;
            const visible = text.trim();
            if (visible) onMessage?.(visible);
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
            cumulative.inputTokens = usage.inputTokens;
            cumulative.outputTokens = usage.outputTokens;
            cumulative.cacheReadTokens = usage.cacheReadTokens;
            cumulative.cacheCreationTokens = usage.cacheCreationTokens;
            onUsage?.({ ...cumulative });
          }
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

          const candidate = lastAssistantText ?? resultText;
          if (!candidate) {
            reject(new Error("cursor returned no agent message"));
            return;
          }

          try {
            const output = parseCursorOutput(candidate, this.schema);
            resolve({ output, usage: cumulative });
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
