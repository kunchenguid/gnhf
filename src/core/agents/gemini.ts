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
  parseJSONLStream,
  setupAbortHandler,
  setupChildProcessHandlers,
} from "./stream-utils.js";

interface GeminiAgentDeps {
  bin?: string;
  extraArgs?: string[];
  platform?: NodeJS.Platform;
  schema?: AgentOutputSchema;
}

type JsonRecord = Record<string, unknown>;

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

function terminateGeminiProcess(
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

  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // Fall back
    }
  }

  child.kill("SIGTERM");
}

function buildGeminiPrompt(prompt: string, schema: AgentOutputSchema): string {
  return `${prompt}

## gnhf final output contract

When the iteration is complete, your final assistant response must be only valid JSON matching this JSON Schema. Do not wrap it in Markdown fences. Do not include prose before or after the JSON object.

${JSON.stringify(schema, null, 2)}`;
}

function buildGeminiArgs(prompt: string, extraArgs?: string[]): string[] {
  return [
    ...(extraArgs ?? []),
    "-y", // YOLO mode, accept tools automatically
    "-o",
    "stream-json",
    "-p",
    prompt,
  ];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toTokenUsage(stats: JsonRecord | undefined): TokenUsage | null {
  if (!stats) return null;

  return {
    inputTokens: (typeof stats.input_tokens === "number" ? stats.input_tokens : 0),
    outputTokens: (typeof stats.output_tokens === "number" ? stats.output_tokens : 0),
    cacheReadTokens: (typeof stats.cached === "number" ? stats.cached : 0),
    cacheCreationTokens: 0,
  };
}

export class GeminiAgent implements Agent {
  name = "gemini";

  private bin: string;
  private extraArgs?: string[];
  private platform: NodeJS.Platform;
  private schema: AgentOutputSchema;

  constructor(deps: GeminiAgentDeps = {}) {
    this.bin = deps.bin ?? "gemini";
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
      const fullPrompt = buildGeminiPrompt(prompt, this.schema);
      const child = spawn(this.bin, buildGeminiArgs(fullPrompt, this.extraArgs), {
        cwd,
        detached: this.platform !== "win32",
        shell: shouldUseWindowsShell(this.bin, this.platform),
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });

      if (
        setupAbortHandler(signal, child, reject, () =>
          terminateGeminiProcess(child, this.platform),
        )
      ) {
        return;
      }

      let assistantText = "";
      let finalUsage: TokenUsage | null = null;
      let hasError = false;
      let errorDetails = "";

      parseJSONLStream<JsonRecord>(child.stdout!, logStream, (event) => {
        if (!isRecord(event)) return;

        if (event.type === "message") {
          if (event.role === "assistant" && typeof event.content === "string") {
            assistantText += event.content;
            if (event.delta) {
              const visible = event.content.trim();
              if (visible) onMessage?.(visible);
            }
          } else if (event.role !== "assistant") {
            assistantText = "";
          }
        }

        if (event.type === "result") {
          if (event.status === "success" && isRecord(event.stats)) {
            finalUsage = toTokenUsage(event.stats);
            if (finalUsage) {
               onUsage?.(finalUsage);
            }
          } else if (event.status === "error") {
             hasError = true;
             errorDetails = typeof event.error === "string" ? event.error : JSON.stringify(event.error);
          }
        }
      });

      setupChildProcessHandlers(child, "gemini", logStream, reject, () => {
        if (hasError) {
          reject(new Error(`gemini reported error: ${errorDetails}`));
          return;
        }

        const finalText = assistantText.trim();

        if (!finalText) {
          reject(new Error("gemini returned no text output"));
          return;
        }

        let parsed: unknown;
        try {
          // Attempt to extract json from possible markdown fences just in case
          // Extract the last markdown fence to handle multiple turns correctly
          const jsonMatches = [...finalText.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/g)];
          let textToParse = finalText;
          
          if (jsonMatches.length > 0) {
            textToParse = jsonMatches[jsonMatches.length - 1][1];
          } else {
            const lastEndBrace = textToParse.lastIndexOf('}');
            if (lastEndBrace !== -1) {
              const textBeforeBrace = textToParse.substring(0, lastEndBrace + 1);
              const matchingStartBrace = textBeforeBrace.lastIndexOf('{');
              if (matchingStartBrace !== -1 && lastEndBrace > matchingStartBrace) {
                // Keep moving back to find the outermost start brace for the last object
                let balance = 0;
                let startBrace = lastEndBrace;
                for (let i = lastEndBrace; i >= 0; i--) {
                  if (textToParse[i] === '}') balance++;
                  else if (textToParse[i] === '{') balance--;
                  
                  if (balance === 0) {
                    startBrace = i;
                    break;
                  }
                }
                textToParse = textToParse.substring(startBrace, lastEndBrace + 1);
              }
            }
          }
          parsed = JSON.parse(textToParse);
        } catch (err) {
          reject(
            new Error(
              `Failed to parse gemini output: ${err instanceof Error ? err.message : err}\nOutput was: ${finalText.substring(0, 200)}`,
            ),
          );
          return;
        }

        try {
          const output = validateAgentOutput(parsed, this.schema);
          resolve({ output, usage: finalUsage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } });
        } catch (err) {
          reject(
            new Error(
              `Invalid gemini output: ${err instanceof Error ? err.message : err}`,
            ),
          );
        }
      });
    });
  }
}
