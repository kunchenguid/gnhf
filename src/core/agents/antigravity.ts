import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import type {
  Agent,
  AgentResult,
  AgentOutput,
  TokenUsage,
  AgentRunOptions,
} from "./types.js";
import {
  setupAbortHandler,
  setupChildProcessHandlers,
} from "./stream-utils.js";
import { parseAgentJson } from "./json-extract.js";

interface AntigravityAgentDeps {
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

function terminateAntigravityProcess(
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

function buildAntigravityArgs(
  prompt: string,
  schemaPath: string,
  extraArgs?: string[],
): string[] {
  const userArgs = extraArgs ?? [];

  return [
    ...userArgs,
    "--print",
    prompt,
    "--json-schema",
    schemaPath,
    "--output-format",
    "json",
  ];
}

export class AntigravityAgent implements Agent {
  name = "antigravity";

  private bin: string;
  private extraArgs?: string[];
  private platform: NodeJS.Platform;
  private schemaPath: string;

  constructor(schemaPath: string, binOrDeps: string | AntigravityAgentDeps = {}) {
    const deps = typeof binOrDeps === "string" ? { bin: binOrDeps } : binOrDeps;
    this.bin = deps.bin ?? "agy";
    this.extraArgs = deps.extraArgs;
    this.platform = deps.platform ?? process.platform;
    this.schemaPath = schemaPath;
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
        buildAntigravityArgs(prompt, this.schemaPath, this.extraArgs),
        {
          cwd,
          shell: shouldUseWindowsShell(this.bin, this.platform),
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        },
      );

      if (
        setupAbortHandler(signal, child, reject, () =>
          terminateAntigravityProcess(child, this.platform),
        )
      ) {
        return;
      }

      let stdout = "";
      const cumulative: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimated: true,
      };

      child.stdout.on("data", (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        onMessage?.(text);
        if (logStream) {
          logStream.write(data);
        }
      });

      setupChildProcessHandlers(child, "antigravity", logStream, reject, () => {
        try {
          let parsed = parseAgentJson(stdout) as any;
          if (!parsed) {
            reject(new Error("Could not find a valid JSON object in antigravity output"));
            return;
          }

          if (typeof parsed === "object" && parsed !== null && "conversation_id" in parsed) {
            if (parsed.status === "ERROR") {
              reject(new Error(`Antigravity failed: ${parsed.response || "unknown error"}`));
              return;
            }
            if (parsed.usage) {
              cumulative.inputTokens = parsed.usage.input_tokens || 0;
              cumulative.outputTokens = parsed.usage.output_tokens || 0;
              cumulative.cacheReadTokens = parsed.usage.cache_read_tokens || 0;
              cumulative.cacheCreationTokens = parsed.usage.cache_creation_tokens || 0;
              cumulative.estimated = false;
            }
            if ("structured_output" in parsed) {
              parsed = parsed.structured_output;
              if (typeof parsed === "string") {
                try {
                  parsed = JSON.parse(parsed);
                } catch {
                  // leave as string
                }
              }
            } else {
              parsed = {
                success: false,
                summary: parsed.response || "Agent did not return structured output.",
              };
            }
          }

          onUsage?.({ ...cumulative });
          resolve({ output: parsed as unknown as AgentOutput, usage: cumulative });
        } catch (err) {
          reject(
            new Error(
              `Failed to parse antigravity output: ${err instanceof Error ? err.message : err}`,
            ),
          );
        }
      });
    });
  }
}
