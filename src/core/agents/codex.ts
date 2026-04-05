import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import type {
  Agent,
  AgentResult,
  AgentOutput,
  TokenUsage,
  AgentRunOptions,
} from "./types.js";
import { consumeJSONLStream } from "./stream-utils.js";

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

type CodexEvent = CodexItemCompleted | CodexTurnCompleted | { type: string };

interface CodexAgentDeps {
  bin?: string;
  platform?: NodeJS.Platform;
}

const CODEX_STARTUP_TIMEOUT_MS = 60_000;
const MAX_STDERR_BUFFER = 64 * 1024;

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

export class CodexAgent implements Agent {
  name = "codex";

  private bin: string;
  private platform: NodeJS.Platform;
  private schemaPath: string;

  constructor(schemaPath: string, binOrDeps: string | CodexAgentDeps = {}) {
    const deps = typeof binOrDeps === "string" ? { bin: binOrDeps } : binOrDeps;
    this.bin = deps.bin ?? "codex";
    this.platform = deps.platform ?? process.platform;
    this.schemaPath = schemaPath;
  }

  async run(
    prompt: string,
    cwd: string,
    options?: AgentRunOptions,
  ): Promise<AgentResult> {
    const { onUsage, onMessage, signal, logPath } = options ?? {};
    const logStream = logPath ? createWriteStream(logPath) : null;

    if (signal?.aborted) {
      logStream?.end();
      throw new Error("Agent was aborted");
    }

    const child = spawn(
      this.bin,
      [
        "exec",
        prompt,
        "--json",
        "--output-schema",
        this.schemaPath,
        "--dangerously-bypass-approvals-and-sandbox",
        "--color",
        "never",
      ],
      {
        cwd,
        shell: shouldUseWindowsShell(this.bin, this.platform),
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );

    let stderr = "";
    const stderrHandler = (data: Buffer) => {
      stderr += data.toString();
      if (stderr.length > MAX_STDERR_BUFFER) {
        stderr = stderr.slice(-MAX_STDERR_BUFFER);
      }
    };
    child.stderr?.on("data", stderrHandler);

    let sawOutput = false;
    child.stdout?.once("data", () => {
      sawOutput = true;
    });

    let lastAgentMessage: string | null = null;
    const cumulative: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };

    const streamPromise = consumeJSONLStream<CodexEvent>(
      child,
      logStream,
      (event) => {
        if (
          event.type === "item.completed" &&
          "item" in event &&
          (event as CodexItemCompleted).item.type === "agent_message"
        ) {
          lastAgentMessage = (event as CodexItemCompleted).item.text;
          onMessage?.(lastAgentMessage);
        }

        if (event.type === "turn.completed" && "usage" in event) {
          const u = (event as CodexTurnCompleted).usage;
          cumulative.inputTokens += u.input_tokens ?? 0;
          cumulative.outputTokens += u.output_tokens ?? 0;
          cumulative.cacheReadTokens += u.cached_input_tokens ?? 0;
          onUsage?.({ ...cumulative });
        }
      },
    );

    let exitCode: number | null = null;
    const exitPromise = new Promise<number | null>((resolve) => {
      child.once("close", (code) => {
        logStream?.end();
        child.stderr?.off("data", stderrHandler);
        exitCode = code;
        resolve(code);
      });
    });

    const errorPromise = new Promise<never>((_, reject) => {
      child.once("error", (err) => {
        logStream?.end();
        child.stderr?.off("data", stderrHandler);
        reject(new Error(`Failed to spawn codex: ${err.message}`));
      });
    });

    const abortPromise = new Promise<never>((_, reject) => {
      const onAbort = () => {
        terminateCodexProcess(child, this.platform);
        reject(new Error("Agent was aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      child.once("close", () => {
        signal?.removeEventListener("abort", onAbort);
      });
    });

    const startupTimeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        if (sawOutput) return;
        terminateCodexProcess(child, this.platform);
        reject(
          new Error(
            `codex did not produce output within ${CODEX_STARTUP_TIMEOUT_MS / 1000}s — it may be hanging on MCP startup or backpressure`,
          ),
        );
      }, CODEX_STARTUP_TIMEOUT_MS);
      timer.unref();
      child.once("close", () => clearTimeout(timer));
    });

    try {
      await Promise.race([
        Promise.all([streamPromise, exitPromise]),
        abortPromise,
        errorPromise,
        startupTimeout,
      ]);
    } catch (err) {
      if (err instanceof Error && err.message === "Agent was aborted") {
        throw err;
      }
      if (exitCode !== null && exitCode !== 0) {
        throw new Error(`codex exited with code ${exitCode}: ${stderr}`);
      }
      throw err;
    }

    if (exitCode !== null && exitCode !== 0) {
      throw new Error(`codex exited with code ${exitCode}: ${stderr}`);
    }

    if (!lastAgentMessage) {
      throw new Error("codex returned no agent message");
    }

    try {
      const output = JSON.parse(lastAgentMessage) as AgentOutput;
      return { output, usage: cumulative };
    } catch (err) {
      throw new Error(
        `Failed to parse codex output: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
