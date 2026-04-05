import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import type {
  Agent,
  AgentResult,
  AgentOutput,
  TokenUsage,
  AgentRunOptions,
} from "./types.js";

const MAX_OUTPUT_BUFFER = 256 * 1024;
const STARTUP_TIMEOUT_MS = 60_000;

const ANSI_ESCAPE_RE =
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

function shouldUseWindowsShell(
  bin: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform !== "win32") return false;
  if (/\.(cmd|bat)$/i.test(bin)) return true;
  if (/[\\/]/.test(bin)) return false;
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

function terminateProcess(
  child: ReturnType<typeof spawn>,
  platform: NodeJS.Platform,
): void {
  if (platform === "win32" && child.pid) {
    try {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
        stdio: "ignore",
      });
    } catch {
      // Best-effort
    }
    return;
  }
  child.kill("SIGTERM");
}

export interface TextBasedAgentDeps {
  bin?: string;
  platform?: NodeJS.Platform;
}

export abstract class TextBasedAgent implements Agent {
  abstract name: string;

  protected bin: string;
  protected platform: NodeJS.Platform;

  constructor(bin: string, deps: TextBasedAgentDeps = {}) {
    this.bin = deps.bin ?? bin;
    this.platform = deps.platform ?? process.platform;
  }

  protected abstract buildArgs(prompt: string): string[];
  protected abstract parseOutput(stdout: string): AgentOutput;
  protected abstract parseUsage(stdout: string): TokenUsage;

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

    const child = spawn(this.bin, this.buildArgs(prompt), {
      cwd,
      shell: shouldUseWindowsShell(this.bin, this.platform),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      if (stdout.length + text.length > MAX_OUTPUT_BUFFER) {
        stdout = (stdout + text).slice(-MAX_OUTPUT_BUFFER);
      } else {
        stdout += text;
      }
      logStream?.write(data);
      const cleaned = stripAnsi(text).trim();
      if (cleaned) onMessage?.(cleaned);
    });

    child.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      if (stderr.length + text.length > MAX_OUTPUT_BUFFER) {
        stderr = (stderr + text).slice(-MAX_OUTPUT_BUFFER);
      } else {
        stderr += text;
      }
      logStream?.write(data);
    });

    const abortPromise = new Promise<never>((_, reject) => {
      const onAbort = () => {
        terminateProcess(child, this.platform);
        reject(new Error("Agent was aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      child.once("close", () => {
        signal?.removeEventListener("abort", onAbort);
      });
    });

    const startupTimeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        terminateProcess(child, this.platform);
        reject(
          new Error(
            `${this.name} did not produce output within ${STARTUP_TIMEOUT_MS / 1000}s`,
          ),
        );
      }, STARTUP_TIMEOUT_MS);
      timer.unref();
      child.once("close", () => clearTimeout(timer));
    });

    const exitPromise = new Promise<number | null>((resolve) => {
      child.once("close", (code) => {
        logStream?.end();
        resolve(code);
      });
    });

    const errorPromise = new Promise<never>((_, reject) => {
      child.once("error", (err) => {
        logStream?.end();
        reject(new Error(`Failed to spawn ${this.name}: ${err.message}`));
      });
    });

    let exitCode: number | null = null;

    try {
      const result = await Promise.race([
        exitPromise.then((code) => {
          exitCode = code;
          return { done: true } as const;
        }),
        abortPromise,
        errorPromise,
        startupTimeout,
      ]);

      if ("done" in result) {
        // Process completed normally
      }
    } catch (err) {
      if (err instanceof Error && err.message === "Agent was aborted") {
        throw err;
      }
      if (exitCode !== null && exitCode !== 0) {
        throw new Error(`${this.name} exited with code ${exitCode}: ${stderr}`);
      }
      throw err;
    }

    if (exitCode !== null && exitCode !== 0) {
      throw new Error(`${this.name} exited with code ${exitCode}: ${stderr}`);
    }

    const cleaned = stripAnsi(stdout);
    let output: AgentOutput;
    try {
      output = this.parseOutput(cleaned);
    } catch (err) {
      throw new Error(
        `Failed to parse ${this.name} output: ${err instanceof Error ? err.message : err}\n\nRaw output (last 500 chars):\n${cleaned.slice(-500)}`,
      );
    }

    const usage = this.parseUsage(cleaned);
    if (onUsage && Object.values(usage).some((v) => v > 0)) {
      onUsage(usage);
    }

    return { output, usage };
  }
}
