import { spawn } from "node:child_process";
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
} from "./types.js";
import { parseAgentJson } from "./json-extract.js";
import {
  parseJSONLStream,
  setupAbortHandler,
  setupChildProcessHandlers,
  shouldUseWindowsShell,
  spawnsDetached,
  terminateChildProcess,
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

/**
 * How much of the streamed text to keep for the renderer's live message panel,
 * which only shows a few wrapped lines. Keeping a bounded trailing window means
 * the panel follows what grok is doing now instead of freezing on the first
 * few lines of the turn.
 */
const LIVE_MESSAGE_CHARS = 200;

/**
 * `stopReason` values that mean the turn did not complete normally. Anything
 * else is treated as terminal-and-fine, because an unrecognised spelling of
 * "finished" must not stall the whole run; a turn that really did end early
 * still fails schema validation of its output.
 */
const FAILED_STOP_REASONS = new Set([
  "aborted",
  "cancel",
  "canceled",
  "cancelled",
  "error",
  "failed",
  "interrupted",
  "maxoutputtokens",
  "maxtokens",
  "refusal",
  "refused",
  "timedout",
  "timeout",
]);

function isFailedStopReason(stopReason: string | undefined): boolean {
  if (!stopReason) return false;
  return FAILED_STOP_REASONS.has(
    stopReason.toLowerCase().replace(/[\s_-]/g, ""),
  );
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
  // Match Claude-style cumulative input accounting: billed/prompt tokens
  // include both fresh input and cache reads when both are reported.
  const inputTokens = (usage.input_tokens ?? 0) + cacheReadTokens;
  const outputTokens = usage.output_tokens ?? 0;
  // grok bills reasoning in its own bucket and only `total_tokens` says whether
  // that bucket is already inside `output_tokens`, so the reported total is the
  // authority for anything the input/output buckets do not account for.
  const totalTokens = usage.total_tokens;
  return {
    inputTokens,
    outputTokens:
      typeof totalTokens === "number"
        ? Math.max(outputTokens, totalTokens - inputTokens)
        : outputTokens,
    cacheReadTokens,
    cacheCreationTokens: 0,
  };
}

function validateGrokOutput(
  value: unknown,
  schema: AgentOutputSchema,
): AgentOutput {
  try {
    return validateAgentOutput(value, schema);
  } catch (err) {
    throw new Error(
      `Invalid grok output: ${err instanceof Error ? err.message : err}`,
    );
  }
}

function matchesSchema(value: unknown, schema: AgentOutputSchema): boolean {
  try {
    validateAgentOutput(value, schema);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prefer grok's own `structuredOutput`, falling back to the streamed text for
 * builds that only emit the JSON answer as prose. The fallback text is the
 * whole turn's transcript, so a schema-aware pass runs first to avoid latching
 * onto an unrelated JSON object the agent happened to print.
 */
function parseGrokOutput(
  end: GrokEndEvent,
  streamedText: string,
  schema: AgentOutputSchema,
): AgentOutput {
  if (end.structuredOutput !== undefined) {
    return validateGrokOutput(end.structuredOutput, schema);
  }

  const finalText = streamedText.trim();
  if (!finalText) {
    throw new Error("grok returned no structuredOutput or text");
  }

  const matched = parseAgentJson(finalText, (value) =>
    matchesSchema(value, schema),
  );
  if (matched !== null) {
    return validateGrokOutput(matched, schema);
  }

  const parsed = parseAgentJson(finalText);
  if (parsed === null) {
    throw new Error("grok output did not contain a parseable JSON object");
  }
  return validateGrokOutput(parsed, schema);
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
      const detached = spawnsDetached(this.platform);
      const child = spawn(
        this.bin,
        buildGrokArgs(prompt, this.schema, this.extraArgs),
        {
          cwd,
          detached,
          shell: shouldUseWindowsShell(this.bin, this.platform),
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        },
      );

      if (
        setupAbortHandler(signal, child, reject, () =>
          terminateChildProcess(child, this.platform, { detached }),
        )
      ) {
        return;
      }

      let endEvent: GrokEndEvent | null = null;
      let textBuffer = "";
      let liveMessage = "";
      let usageReported = false;

      // grok reports usage exactly once, in the terminal `end` event that
      // immediately precedes process exit. Surfacing it before this run settles
      // would let a `--max-tokens` abort roll back an iteration that has
      // already finished, so it is always reported after the promise settles
      // and left to the orchestrator's post-iteration limit check.
      const reportUsage = () => {
        if (usageReported || !endEvent) return;
        usageReported = true;
        onUsage?.(toTokenUsage(endEvent.usage));
      };

      parseJSONLStream<GrokEvent>(child.stdout!, logStream, (event) => {
        if (event.type === "text") {
          const data =
            "data" in event && typeof event.data === "string" ? event.data : "";
          if (!data) return;
          textBuffer += data;
          liveMessage = (liveMessage + data).slice(-LIVE_MESSAGE_CHARS);
          const visible = liveMessage.trim();
          if (visible) onMessage?.(visible);
          return;
        }

        if (event.type === "end") {
          endEvent = event as GrokEndEvent;
        }
      });

      setupChildProcessHandlers(
        child,
        "grok",
        logStream,
        (err) => {
          reject(err);
          reportUsage();
        },
        () => {
          try {
            const end = endEvent;
            if (!end) {
              throw new Error("grok returned no end event");
            }
            if (isFailedStopReason(end.stopReason)) {
              throw new Error(
                `grok reported stopReason ${JSON.stringify(end.stopReason)}`,
              );
            }
            resolve({
              output: parseGrokOutput(end, textBuffer, this.schema),
              usage: toTokenUsage(end.usage),
            });
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          } finally {
            reportUsage();
          }
        },
      );
    });
  }
}
