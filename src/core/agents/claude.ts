import { execFileSync, spawn } from "node:child_process";
import {
  buildAgentOutputSchema,
  type Agent,
  type AgentOutput,
  type AgentOutputSchema,
  type AgentResult,
  type AgentRunOptions,
  type OnMessage,
  type OnUsage,
  type TokenUsage,
  PermanentAgentError,
} from "./types.js";
import { appendDebugLog } from "../debug-log.js";
import {
  EmptyAgentResponseError,
  runTurnWithEmptyResponseRetry,
} from "./empty-response.js";
import { shutdownChildProcess } from "./managed-process.js";
import {
  AgentLogFile,
  parseJSONLStream,
  setupAbortHandler,
} from "./stream-utils.js";

const DEFAULT_FINAL_RESULT_EXIT_GRACE_MS = 15_000;
/** Upper bound on the stdout tail kept for non-zero-exit error reporting. */
const MAX_EXIT_OUTPUT_CHARS = 4_000;
/**
 * Tighter bound on unstructured stdout quoted back in the failure detail: that
 * text lands in notes.md and is replayed in every later iteration prompt.
 */
const MAX_RAW_TAIL_CHARS = 400;
const RAW_TAIL_ELISION = "[...truncated, full output in the iteration log] ";

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

type ClaudeEvent =
  | ClaudeAssistantEvent
  | ClaudeResultEvent
  | { type: string; session_id?: string };

interface ClaudeAgentDeps {
  bin?: string;
  extraArgs?: string[];
  finalResultGraceMs?: number;
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

async function shutdownClaudeProcess(
  child: ReturnType<typeof spawn>,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform === "win32") {
    terminateClaudeProcess(child, platform);
    return;
  }

  await shutdownChildProcess(child, {
    detached: true,
  });
}

function isFinalStructuredResult(event: ClaudeResultEvent): boolean {
  return (
    !event.is_error && event.subtype === "success" && !!event.structured_output
  );
}

function isSessionContinuationArg(arg: string): boolean {
  return arg === "-c" || arg === "--continue";
}

// `--no-session-persistence` tells claude not to write the session to disk, so
// there is nothing for `--resume` to reopen.
function sessionPersistenceDisabled(userArgs: string[]): boolean {
  return userArgs.some((arg) => arg === "--no-session-persistence");
}

function buildClaudeArgs(
  prompt: string,
  schema: AgentOutputSchema,
  extraArgs?: string[],
  resumeSessionId?: string | null,
): string[] {
  const userArgs = extraArgs ?? [];
  const turnArgs = resumeSessionId
    ? userArgs.filter((arg) => !isSessionContinuationArg(arg))
    : userArgs;
  const userSpecifiedPermissionMode = turnArgs.some(
    (arg) =>
      arg === "--dangerously-skip-permissions" ||
      arg === "--permission-mode" ||
      arg.startsWith("--permission-mode=") ||
      arg === "--permission-prompt-tool" ||
      arg.startsWith("--permission-prompt-tool="),
  );

  return [
    ...turnArgs,
    "-p",
    prompt,
    "--verbose",
    "--output-format",
    "stream-json",
    "--json-schema",
    JSON.stringify(schema),
    ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
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

function isPermanentClaudeError(output: string): boolean {
  return /credit balance\s+is\s+too\s+low/i.test(output);
}

/** Keep only the last `MAX_EXIT_OUTPUT_CHARS` characters so long streams stay bounded. */
function appendBoundedTail(existing: string, chunk: string): string {
  const combined = existing + chunk;
  return combined.length > MAX_EXIT_OUTPUT_CHARS
    ? combined.slice(combined.length - MAX_EXIT_OUTPUT_CHARS)
    : combined;
}

function errorTextFromEvent(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const record = event as Record<string, unknown>;

  const error = record.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }

  if (record.is_error === true || record.type === "error") {
    for (const key of ["result", "message", "subtype"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }

  return null;
}

/** Quote only the end of unstructured output, marking what was dropped. */
function elideRawTail(raw: string): string {
  return raw.length > MAX_RAW_TAIL_CHARS
    ? `${RAW_TAIL_ELISION}${raw.slice(raw.length - MAX_RAW_TAIL_CHARS)}`
    : raw;
}

interface StdoutFailure {
  /** Error text the CLI itself authored in structured stdout events. */
  structured: string;
  /** Text worth reporting: the structured text, or a short raw tail. */
  reported: string;
}

/**
 * Pull the CLI's own error text out of its stdout, which is JSONL when the run
 * got far enough to stream events and plain text otherwise. Falls back to a
 * bounded raw tail so the reported detail is never empty when stdout had
 * content.
 */
function extractStdoutError(stdoutTail: string): StdoutFailure {
  const messages: string[] = [];
  for (const line of stdoutTail.split("\n")) {
    if (!line.trim()) continue;
    try {
      const message = errorTextFromEvent(JSON.parse(line));
      if (message) messages.push(message);
    } catch {
      // Not JSON: covered by the raw-tail fallback below.
    }
  }
  const structured = messages.join("\n");
  return {
    structured,
    reported: structured || elideRawTail(stdoutTail.trim()),
  };
}

interface ExitFailure {
  detail: string;
  permanent: boolean;
}

/**
 * Describe a non-zero exit. `detail` reports everything both streams offered,
 * while `permanent` is decided only from text the CLI itself authored - stderr
 * and structured stdout error fields - so agent output that merely quotes a
 * permanent-failure phrase cannot abort an otherwise retryable run.
 */
function describeExitFailure(
  code: number | null,
  stdoutTail: string,
  stderr: string,
): ExitFailure {
  const trimmedStderr = stderr.trim();
  const stdoutError = extractStdoutError(stdoutTail);
  const segments = [trimmedStderr, stdoutError.reported].filter(Boolean);
  return {
    detail:
      segments.length > 0
        ? `claude exited with code ${code}: ${segments.join("\n")}`
        : `claude exited with code ${code} and produced no output`,
    permanent: isPermanentClaudeError(
      [trimmedStderr, stdoutError.structured].filter(Boolean).join("\n"),
    ),
  };
}

export class ClaudeAgent implements Agent {
  name = "claude";

  private bin: string;
  private extraArgs?: string[];
  private finalResultGraceMs: number;
  private platform: NodeJS.Platform;
  private schema: AgentOutputSchema;

  constructor(binOrDeps: string | ClaudeAgentDeps = {}) {
    const deps = typeof binOrDeps === "string" ? { bin: binOrDeps } : binOrDeps;
    this.bin = deps.bin ?? "claude";
    this.extraArgs = deps.extraArgs;
    this.finalResultGraceMs =
      deps.finalResultGraceMs ?? DEFAULT_FINAL_RESULT_EXIT_GRACE_MS;
    this.platform = deps.platform ?? process.platform;
    this.schema =
      deps.schema ?? buildAgentOutputSchema({ includeStopField: false });
  }

  async run(
    prompt: string,
    cwd: string,
    options?: AgentRunOptions,
  ): Promise<AgentResult> {
    const { onUsage, onMessage, signal, logPath } = options ?? {};
    const logFile = new AgentLogFile(logPath);
    // Populated from the first turn's stream so a continuation resumes that
    // exact conversation and still sees its own reasoning and tool calls.
    let sessionId: string | null = null;

    try {
      // `--json-schema` is a spawn flag, so the continuation turn keeps the
      // output contract without any extra prompt scaffolding.
      return await runTurnWithEmptyResponseRetry({
        logEvent: "claude:output:continuation",
        onUsage,
        signal,
        initialText: prompt,
        runTurn: (text, onTurnUsage) =>
          this.runTurn(text, cwd, {
            onUsage: onTurnUsage,
            onMessage,
            signal,
            logFile,
            resumeSessionId: sessionId,
            onSessionId: (id) => {
              sessionId = id;
            },
          }),
      });
    } finally {
      logFile.finish();
    }
  }

  private runTurn(
    prompt: string,
    cwd: string,
    options: {
      onUsage?: OnUsage;
      onMessage?: OnMessage;
      signal?: AbortSignal;
      logFile: AgentLogFile;
      resumeSessionId: string | null;
      onSessionId: (sessionId: string) => void;
    },
  ): Promise<AgentResult> {
    const { onUsage, onMessage, signal, logFile } = options;
    const { resumeSessionId, onSessionId } = options;

    return new Promise((resolve, reject) => {
      const child = spawn(
        this.bin,
        buildClaudeArgs(prompt, this.schema, this.extraArgs, resumeSessionId),
        {
          cwd,
          detached: this.platform !== "win32",
          shell: shouldUseWindowsShell(this.bin, this.platform),
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        },
      );
      logFile.track(child);

      if (
        setupAbortHandler(signal, child, reject, () =>
          terminateClaudeProcess(child, this.platform),
        )
      ) {
        return;
      }

      let resultEvent: ClaudeResultEvent | null = null;
      let turnSessionId: string | null = resumeSessionId;
      let finalStructuredResultEvent: ClaudeResultEvent | null = null;
      let latestResultUsage: ClaudeResultEvent["usage"] | null = null;
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
      const usageByMessageId = new Map<string, TokenUsage>();
      let anonymousAssistantCount = 0;
      let lastAnonymousAssistantId: string | null = null;
      let lastAnonymousAssistantUsage: TokenUsage | null = null;
      let pendingAnonymousAssistantUsage: TokenUsage | null = null;

      child.stderr!.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.stdout!.on("data", (data: Buffer) => {
        stdoutTail = appendBoundedTail(stdoutTail, data.toString());
      });

      child.on("error", (err) => {
        reject(new Error(`Failed to spawn claude: ${err.message}`));
      });

      parseJSONLStream<ClaudeEvent>(child.stdout!, logFile, (event) => {
        const eventSessionId = (event as { session_id?: unknown }).session_id;
        if (typeof eventSessionId === "string" && eventSessionId) {
          turnSessionId = eventSessionId;
          onSessionId(eventSessionId);
        }

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
          const next = event as ClaudeResultEvent;
          latestResultUsage = next.usage;
          if (isFinalStructuredResult(next)) {
            finalStructuredResultEvent = next;
            if (finalResultCleanupTimer) {
              clearTimeout(finalResultCleanupTimer);
            }
            finalResultCleanupTimer = setTimeout(() => {
              closedAfterFinalCleanup = true;
              void shutdownClaudeProcess(child, this.platform);
            }, this.finalResultGraceMs);
          } else if (
            !finalStructuredResultEvent &&
            (next.is_error ||
              next.subtype !== "success" ||
              next.structured_output ||
              !resultEvent)
          ) {
            resultEvent = next;
          }
        }
      });

      child.on("close", (code) => {
        if (finalResultCleanupTimer) {
          clearTimeout(finalResultCleanupTimer);
        }
        if (code !== 0 && !closedAfterFinalCleanup) {
          const failure = describeExitFailure(code, stdoutTail, stderr);
          reject(
            failure.permanent
              ? new PermanentAgentError(
                  "claude credit balance too low - see gnhf.log",
                  failure.detail,
                )
              : new Error(failure.detail),
          );
          return;
        }

        const terminalResultEvent = finalStructuredResultEvent ?? resultEvent;

        if (!terminalResultEvent) {
          reject(new Error("claude returned no result event"));
          return;
        }

        if (
          terminalResultEvent.is_error ||
          terminalResultEvent.subtype !== "success"
        ) {
          reject(
            new Error(
              `claude reported error: ${JSON.stringify(terminalResultEvent)}`,
            ),
          );
          return;
        }

        if (!terminalResultEvent.structured_output) {
          const userArgs = this.extraArgs ?? [];
          const resumeBlockedReason = sessionPersistenceDisabled(userArgs)
            ? "--no-session-persistence disables session resume, so the turn cannot be continued"
            : !turnSessionId
              ? "claude reported no session id, so the turn cannot be resumed"
              : null;
          appendDebugLog("claude:output:missing", {
            subtype: terminalResultEvent.subtype,
            resumed: resumeSessionId !== null,
            hasSessionId: turnSessionId !== null,
            resumeBlockedReason,
          });
          reject(
            new EmptyAgentResponseError(
              resumeBlockedReason
                ? `claude returned no structured_output (${resumeBlockedReason})`
                : "claude returned no structured_output",
              {
                // A non-error `result` event with subtype "success" is claude's
                // own end-of-turn signal; it just carried no final answer.
                turnCompleted: resumeBlockedReason === null,
                usage: toTokenUsage(
                  latestResultUsage ?? terminalResultEvent.usage,
                ),
              },
            ),
          );
          return;
        }

        const output: AgentOutput = terminalResultEvent.structured_output;
        const usage = toTokenUsage(
          latestResultUsage ?? terminalResultEvent.usage,
        );

        onUsage?.(usage);
        resolve({ output, usage });
      });
    });
  }
}
