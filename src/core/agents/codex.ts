import { execFileSync, spawn } from "node:child_process";
import type {
  Agent,
  AgentResult,
  AgentOutput,
  OnMessage,
  OnUsage,
  TokenUsage,
  AgentRunOptions,
} from "./types.js";
import { appendDebugLog } from "../debug-log.js";
import {
  EmptyAgentResponseError,
  runTurnWithEmptyResponseRetry,
} from "./empty-response.js";
import {
  AgentLogFile,
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

interface CodexThreadStarted {
  type: "thread.started";
  thread_id?: string;
  threadId?: string;
  id?: string;
}

type CodexEvent =
  | CodexItemCompleted
  | CodexTurnCompleted
  | CodexThreadStarted
  | { type: string };

function threadIdOf(event: CodexThreadStarted): string | null {
  const candidate = event.thread_id ?? event.threadId ?? event.id;
  return typeof candidate === "string" && candidate ? candidate : null;
}

// `codex exec resume` is a narrower subcommand than `codex exec` and clap
// rejects anything it does not declare. Rather than silently downgrading a
// user's sandbox choice or shelling out a command codex will refuse - which
// would replace the accurate empty-response diagnostic with a CLI usage error
// - gnhf skips the empty-response continuation for these configurations.
// Verified against codex-cli 0.147.0 by diffing `codex exec --help` against
// `codex exec resume --help`; the approval flags are kept because older codex
// releases still accept them on `codex exec` and resume rejects them too.
const CODEX_RESUME_UNSUPPORTED_ARGS = [
  "--add-dir",
  "-C",
  "--cd",
  "-s",
  "--sandbox",
  "--approve-for-me",
  "--oss",
  "--local-provider",
  "-p",
  "--profile",
  "--full-auto",
  "-a",
  "--ask-for-approval",
];

// `--ephemeral` is accepted by both `codex exec` and `codex exec resume`, so
// the denylist above cannot catch it: the block is semantic. An ephemeral run
// records no rollout, so resuming its thread id fails with "no rollout found".
function codexRecordsNoRollout(extraArgs?: string[]): boolean {
  return (extraArgs ?? []).includes("--ephemeral");
}

function codexResumeUnsupportedArg(extraArgs?: string[]): string | null {
  return (
    (extraArgs ?? []).find((arg) =>
      CODEX_RESUME_UNSUPPORTED_ARGS.some(
        (unsupported) =>
          arg === unsupported || arg.startsWith(`${unsupported}=`),
      ),
    ) ?? null
  );
}

interface CodexAgentDeps {
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

function terminateCodexProcess(
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

function userSpecifiedExecutionMode(userArgs: string[]): boolean {
  return userArgs.some(
    (arg) =>
      arg === "--full-auto" ||
      arg === "--dangerously-bypass-approvals-and-sandbox" ||
      arg === "--sandbox" ||
      arg.startsWith("--sandbox=") ||
      arg === "-s" ||
      arg === "--ask-for-approval" ||
      arg.startsWith("--ask-for-approval=") ||
      arg === "-a",
  );
}

function buildCodexArgs(
  prompt: string,
  schemaPath: string,
  extraArgs?: string[],
): string[] {
  const userArgs = extraArgs ?? [];

  return [
    "exec",
    ...userArgs,
    prompt,
    "--json",
    "--output-schema",
    schemaPath,
    ...(userSpecifiedExecutionMode(userArgs)
      ? []
      : ["--dangerously-bypass-approvals-and-sandbox"]),
    "--color",
    "never",
  ];
}

// `codex exec resume <thread-id>` replays the recorded session, so the
// continuation turn keeps the first turn's reasoning and tool calls. It does
// not accept `--color`, so that flag is dropped here rather than forwarded.
function buildCodexResumeArgs(
  prompt: string,
  schemaPath: string,
  threadId: string,
  extraArgs?: string[],
): string[] {
  const userArgs = extraArgs ?? [];

  return [
    "exec",
    "resume",
    ...userArgs,
    threadId,
    prompt,
    "--json",
    "--output-schema",
    schemaPath,
    ...(userSpecifiedExecutionMode(userArgs)
      ? []
      : ["--dangerously-bypass-approvals-and-sandbox"]),
  ];
}

export class CodexAgent implements Agent {
  name = "codex";

  private bin: string;
  private extraArgs?: string[];
  private platform: NodeJS.Platform;
  private schemaPath: string;

  constructor(schemaPath: string, binOrDeps: string | CodexAgentDeps = {}) {
    const deps = typeof binOrDeps === "string" ? { bin: binOrDeps } : binOrDeps;
    this.bin = deps.bin ?? "codex";
    this.extraArgs = deps.extraArgs;
    this.platform = deps.platform ?? process.platform;
    this.schemaPath = schemaPath;
  }

  async run(
    prompt: string,
    cwd: string,
    options?: AgentRunOptions,
  ): Promise<AgentResult> {
    const { onUsage, onMessage, signal, logPath } = options ?? {};
    const logFile = new AgentLogFile(logPath);
    let threadId: string | null = null;

    try {
      // `--output-schema` is a spawn flag, so the continuation turn carries the
      // same output contract without any extra prompt scaffolding.
      return await runTurnWithEmptyResponseRetry({
        logEvent: "codex:output:continuation",
        onUsage,
        signal,
        initialText: prompt,
        runTurn: (text, onTurnUsage) =>
          this.runTurn(text, cwd, {
            onUsage: onTurnUsage,
            onMessage,
            signal,
            logFile,
            resumeThreadId: threadId,
            onThreadId: (id) => {
              threadId = id;
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
      resumeThreadId: string | null;
      onThreadId: (threadId: string) => void;
    },
  ): Promise<AgentResult> {
    const { onUsage, onMessage, signal, logFile } = options;
    const { resumeThreadId, onThreadId } = options;

    return new Promise((resolve, reject) => {
      const child = spawn(
        this.bin,
        resumeThreadId
          ? buildCodexResumeArgs(
              prompt,
              this.schemaPath,
              resumeThreadId,
              this.extraArgs,
            )
          : buildCodexArgs(prompt, this.schemaPath, this.extraArgs),
        {
          cwd,
          shell: shouldUseWindowsShell(this.bin, this.platform),
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        },
      );
      logFile.track(child);

      if (
        setupAbortHandler(signal, child, reject, () =>
          terminateCodexProcess(child, this.platform),
        )
      ) {
        return;
      }

      let lastAgentMessage: string | null = null;
      // `turn.completed` is codex's own end-of-turn signal, so it - not a
      // clean process exit - is what separates a finished-but-silent turn
      // from a turn that never got to answer.
      let sawTurnCompleted = false;
      let turnThreadId: string | null = resumeThreadId;
      const cumulative: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };

      parseJSONLStream<CodexEvent>(child.stdout!, logFile, (event) => {
        if (event.type === "thread.started") {
          const id = threadIdOf(event as CodexThreadStarted);
          if (id) {
            turnThreadId = id;
            onThreadId(id);
          }
        }

        if (
          event.type === "item.completed" &&
          "item" in event &&
          (event as CodexItemCompleted).item.type === "agent_message"
        ) {
          lastAgentMessage = (event as CodexItemCompleted).item.text;
          onMessage?.(lastAgentMessage);
        }

        if (event.type === "turn.completed") {
          sawTurnCompleted = true;
          if ("usage" in event) {
            const u = (event as CodexTurnCompleted).usage;
            cumulative.inputTokens += u.input_tokens ?? 0;
            cumulative.outputTokens += u.output_tokens ?? 0;
            cumulative.cacheReadTokens += u.cached_input_tokens ?? 0;
            onUsage?.({ ...cumulative });
          }
        }
      });

      setupChildProcessHandlers(child, "codex", reject, () => {
        const finalAgentMessage = lastAgentMessage?.trim();
        if (!finalAgentMessage) {
          const unsupportedArg = codexResumeUnsupportedArg(this.extraArgs);
          const resumeBlockedReason = !turnThreadId
            ? "codex reported no thread id, so the turn cannot be resumed"
            : codexRecordsNoRollout(this.extraArgs)
              ? "--ephemeral records no rollout, so the thread cannot be resumed"
              : unsupportedArg
                ? `configured codex arg "${unsupportedArg}" is not supported by \`codex exec resume\`, so the turn cannot be resumed`
                : null;
          appendDebugLog("codex:output:missing", {
            sawTurnCompleted,
            hasThreadId: turnThreadId !== null,
            resumeBlockedReason,
          });
          reject(
            new EmptyAgentResponseError(
              resumeBlockedReason
                ? `codex returned no agent message (${resumeBlockedReason})`
                : "codex returned no agent message",
              {
                turnCompleted: sawTurnCompleted && resumeBlockedReason === null,
                usage: cumulative,
              },
            ),
          );
          return;
        }

        try {
          const output = JSON.parse(finalAgentMessage) as AgentOutput;
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
