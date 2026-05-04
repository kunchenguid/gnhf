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
import {
  setupAbortHandler,
  setupChildProcessHandlers,
} from "./stream-utils.js";

interface SwivalAgentDeps {
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

function terminateSwivalProcess(
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

function userSpecifiedPermissionMode(userArgs: string[]): boolean {
  return userArgs.some(
    (arg) =>
      arg === "--yolo" ||
      arg === "--files" ||
      arg.startsWith("--files=") ||
      arg === "--commands" ||
      arg.startsWith("--commands="),
  );
}

function buildSwivalPrompt(prompt: string, schema: AgentOutputSchema): string {
  return `${prompt}

## gnhf final output contract

When the iteration is complete, your final answer must be a single JSON object that matches this JSON Schema. Do not wrap it in Markdown fences. Do not include explanatory prose before or after the JSON object.

${JSON.stringify(schema, null, 2)}`;
}

function buildSwivalArgs(extraArgs?: string[]): string[] {
  const userArgs = extraArgs ?? [];
  return [
    ...userArgs,
    ...(userSpecifiedPermissionMode(userArgs) ? [] : ["--yolo"]),
    "--no-color",
    "-q",
  ];
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

export class SwivalAgent implements Agent {
  name = "swival";

  private bin: string;
  private extraArgs?: string[];
  private platform: NodeJS.Platform;
  private schema: AgentOutputSchema;

  constructor(deps: SwivalAgentDeps = {}) {
    this.bin = deps.bin ?? "swival";
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
    const { onMessage, signal, logPath } = options ?? {};

    return new Promise((resolve, reject) => {
      const logStream = logPath ? createWriteStream(logPath) : null;

      const child = spawn(this.bin, buildSwivalArgs(this.extraArgs), {
        cwd,
        shell: shouldUseWindowsShell(this.bin, this.platform),
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
        detached: this.platform !== "win32",
      });

      child.stdin?.write(buildSwivalPrompt(prompt, this.schema));
      child.stdin?.end();

      if (
        setupAbortHandler(signal, child, reject, () =>
          terminateSwivalProcess(child, this.platform),
        )
      ) {
        return;
      }

      let stdoutBuffer = "";

      child.stdout!.on("data", (data: Buffer) => {
        logStream?.write(data);
        stdoutBuffer += data.toString();
      });

      const usage: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };

      setupChildProcessHandlers(child, "swival", logStream, reject, () => {
        const finalText = stdoutBuffer.trim();

        if (!finalText) {
          reject(new Error("swival returned no output"));
          return;
        }

        onMessage?.(finalText);

        let parsed: unknown;
        try {
          parsed = JSON.parse(stripJsonFence(finalText));
        } catch (err) {
          reject(
            new Error(
              `Failed to parse swival output: ${err instanceof Error ? err.message : err}`,
            ),
          );
          return;
        }

        try {
          const output = validateAgentOutput(parsed, this.schema);
          resolve({ output, usage });
        } catch (err) {
          reject(
            new Error(
              `Invalid swival output: ${err instanceof Error ? err.message : err}`,
            ),
          );
        }
      });
    });
  }
}
