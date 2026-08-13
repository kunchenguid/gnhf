import { execFileSync, spawn } from "node:child_process";
import {
  accessSync,
  constants,
  createWriteStream,
  readdirSync,
  statSync,
} from "node:fs";
import { posix, win32 } from "node:path";
import {
  buildAgentOutputSchema,
  parseAgentOutput,
  PermanentAgentError,
  type Agent,
  type AgentOutputSchema,
  type AgentResult,
  type AgentRunOptions,
  type TokenUsage,
} from "./types.js";
import { shutdownChildProcess } from "./managed-process.js";
import { parseJSONLStream, setupAbortHandler } from "./stream-utils.js";

const DEFAULT_FINAL_RESULT_EXIT_GRACE_MS = 15_000;
/**
 * Cursor's installer symlinks the same binary as both `cursor-agent` and the
 * generic `agent`. Prefer the unambiguous name so an unrelated `agent` on PATH
 * cannot be driven by mistake, and fall back to `agent` for installs that only
 * expose the newer name.
 */
const CURSOR_BIN_CANDIDATES = ["cursor-agent", "agent"] as const;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function candidateExistsOnPath(
  directory: string,
  candidate: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform !== "win32") {
    return isExecutableFile(posix.join(directory, candidate));
  }

  const extensions = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((extension) =>
      extension.startsWith(".") ? extension : `.${extension}`,
    );
  const expectedNames = new Set(
    [candidate, ...extensions.map((extension) => candidate + extension)].map(
      (name) => name.toLowerCase(),
    ),
  );

  try {
    return readdirSync(directory).some(
      (name) =>
        expectedNames.has(name.toLowerCase()) &&
        isFile(win32.join(directory, name)),
    );
  } catch {
    return false;
  }
}

function resolveCursorBin(platform: NodeJS.Platform): string {
  const delimiter = platform === "win32" ? ";" : ":";
  const directories = (process.env.PATH ?? "").split(delimiter).filter(Boolean);

  for (const candidate of CURSOR_BIN_CANDIDATES) {
    if (
      directories.some((directory) =>
        candidateExistsOnPath(directory, candidate, platform),
      )
    ) {
      return candidate;
    }
  }
  return CURSOR_BIN_CANDIDATES[0];
}

interface CursorAgentDeps {
  bin?: string;
  extraArgs?: string[];
  finalResultGraceMs?: number;
  platform?: NodeJS.Platform;
  schema?: AgentOutputSchema;
}

type JsonRecord = Record<string, unknown>;

interface CursorResultEvent {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  result?: string;
  usage?: JsonRecord;
}

type CursorEvent =
  | {
      type: "assistant";
      message?: {
        content?: unknown;
      };
    }
  | CursorResultEvent
  | { type: string };

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

async function shutdownCursorProcess(
  child: ReturnType<typeof spawn>,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform === "win32") {
    terminateCursorProcess(child, platform);
    return;
  }

  await shutdownChildProcess(child, {
    detached: true,
  });
}

function isNonErrorResult(event: CursorResultEvent): boolean {
  return !event.is_error && event.subtype !== "error";
}

function userSpecifiedPermissionMode(userArgs: string[]): boolean {
  return userArgs.some(
    (arg) =>
      arg === "--force" ||
      arg === "-f" ||
      arg === "--yolo" ||
      arg === "--auto-review",
  );
}

function userSpecifiedTrust(userArgs: string[]): boolean {
  return userArgs.some((arg) => arg === "--trust");
}

function userSpecifiedApproveMcps(userArgs: string[]): boolean {
  return userArgs.some((arg) => arg === "--approve-mcps");
}

function buildCursorPrompt(prompt: string, schema: AgentOutputSchema): string {
  return `${prompt}

## gnhf final output contract

When the iteration is complete, your final answer must be a single JSON object that matches this JSON Schema:

\`\`\`json
${JSON.stringify(schema, null, 2)}
\`\`\`

Return only the JSON object in the final answer. Do not wrap it in Markdown. Do not include explanatory prose outside the JSON object.`;
}

function buildCursorArgs(extraArgs?: string[]): string[] {
  const userArgs = extraArgs ?? [];

  return [
    ...userArgs,
    "-p",
    "--output-format",
    "stream-json",
    ...(userSpecifiedPermissionMode(userArgs) ? [] : ["--force"]),
    ...(userSpecifiedTrust(userArgs) ? [] : ["--trust"]),
    ...(userSpecifiedApproveMcps(userArgs) ? [] : ["--approve-mcps"]),
  ];
}

function numberField(usage: JsonRecord, names: string[]): number | undefined {
  for (const name of names) {
    const value = usage[name];
    if (typeof value === "number") {
      return value;
    }
  }
  return undefined;
}

function usageFromRecord(usage: JsonRecord): TokenUsage | null {
  const inputTokens = numberField(usage, ["inputTokens", "input_tokens"]);
  const outputTokens = numberField(usage, ["outputTokens", "output_tokens"]);
  const cacheReadTokens = numberField(usage, [
    "cacheReadTokens",
    "cache_read_tokens",
    "cache_read_input_tokens",
  ]);
  const cacheCreationTokens = numberField(usage, [
    "cacheWriteTokens",
    "cacheCreationTokens",
    "cache_write_tokens",
    "cache_creation_tokens",
    "cache_creation_input_tokens",
  ]);

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

function textFromContentBlock(block: unknown): string | null {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  const record = block as JsonRecord;
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  return null;
}

function textFromAssistantMessage(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map(textFromContentBlock)
      .filter((text): text is string => text !== null)
      .join("");
  }
  return "";
}

/**
 * Auth failures need a human to run `cursor-agent login`, so retrying only
 * burns the run's consecutive-failure budget. Classify them from text the CLI
 * itself authored, never from agent output that may merely quote the phrase.
 */
function isPermanentCursorError(output: string): boolean {
  return /authentication required|not (?:logged in|authenticated)/i.test(
    output,
  );
}

export class CursorAgent implements Agent {
  name = "cursor";

  private bin: string;
  private extraArgs?: string[];
  private finalResultGraceMs: number;
  private platform: NodeJS.Platform;
  private schema: AgentOutputSchema;

  constructor(deps: CursorAgentDeps = {}) {
    this.extraArgs = deps.extraArgs;
    this.finalResultGraceMs =
      deps.finalResultGraceMs ?? DEFAULT_FINAL_RESULT_EXIT_GRACE_MS;
    this.platform = deps.platform ?? process.platform;
    this.bin = deps.bin ?? resolveCursorBin(this.platform);
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
      const child = spawn(this.bin, buildCursorArgs(this.extraArgs), {
        cwd,
        detached: this.platform !== "win32",
        shell: shouldUseWindowsShell(this.bin, this.platform),
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });

      child.stdin?.write(buildCursorPrompt(prompt, this.schema));
      child.stdin?.end();

      if (
        setupAbortHandler(signal, child, reject, () =>
          terminateCursorProcess(child, this.platform),
        )
      ) {
        return;
      }

      let lastAssistantText: string | null = null;
      let resultText: string | null = null;
      let resultError: string | null = null;
      let finalResultCleanupTimer: ReturnType<typeof setTimeout> | null = null;
      let closedAfterFinalCleanup = false;
      let stderr = "";
      let usage: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };

      child.stderr!.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("error", (err) => {
        reject(new Error(`Failed to spawn cursor: ${err.message}`));
      });

      parseJSONLStream<CursorEvent>(child.stdout!, logStream, (event) => {
        if (event.type === "assistant") {
          const text = textFromAssistantMessage(
            (event as { message?: { content?: unknown } }).message ?? {},
          ).trim();
          if (text) {
            lastAssistantText = text;
            onMessage?.(text);
          }
          return;
        }

        if (event.type !== "result") return;

        const result = event as CursorResultEvent;
        if (typeof result.result === "string") {
          resultText = result.result;
        }

        if (result.is_error || result.subtype === "error") {
          resultError =
            (typeof result.result === "string" && result.result.trim()) ||
            "cursor reported an error result";
        }

        if (result.usage) {
          const nextUsage = usageFromRecord(result.usage);
          if (nextUsage) {
            usage = nextUsage;
            onUsage?.({ ...usage });
          }
        }

        if (isNonErrorResult(result)) {
          if (finalResultCleanupTimer) {
            clearTimeout(finalResultCleanupTimer);
          }
          finalResultCleanupTimer = setTimeout(() => {
            closedAfterFinalCleanup = true;
            void shutdownCursorProcess(child, this.platform);
          }, this.finalResultGraceMs);
        }
      });

      child.on("close", (code) => {
        if (finalResultCleanupTimer) {
          clearTimeout(finalResultCleanupTimer);
        }
        logStream?.end();
        if (code !== 0 && !closedAfterFinalCleanup) {
          const detail = `cursor exited with code ${code}: ${stderr}`;
          reject(
            isPermanentCursorError(stderr)
              ? new PermanentAgentError(
                  "cursor is not signed in - run `cursor-agent login`",
                  detail,
                )
              : new Error(detail),
          );
          return;
        }

        if (resultError) {
          reject(
            isPermanentCursorError(resultError)
              ? new PermanentAgentError(
                  "cursor is not signed in - run `cursor-agent login`",
                  resultError,
                )
              : new Error(resultError),
          );
          return;
        }

        const finalText = (lastAssistantText ?? resultText ?? "").trim();
        if (!finalText) {
          reject(new Error("cursor returned no text output"));
          return;
        }

        try {
          const output = parseAgentOutput(finalText, this.schema, "cursor");
          resolve({ output, usage });
        } catch (err) {
          reject(
            new Error(
              `Failed to parse cursor output: ${err instanceof Error ? err.message : err}`,
            ),
          );
        }
      });
    });
  }
}
