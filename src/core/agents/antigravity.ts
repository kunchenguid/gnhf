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
  parseJSONLStream,
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
    "stream-json",
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

      let streamedResponse = "";
      let resultEvent: any = null;
      const cumulative: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimated: true,
      };

      parseJSONLStream<any>(child.stdout!, logStream, (event) => {
        if (event.event === "step_update" && event.step_update) {
          const step = event.step_update;
          
          // 1. Capture standard text (what you already had)
          if (step.step_type === "agent_response" && step.text_delta) {
            streamedResponse += step.text_delta;
            onMessage?.(step.text_delta);
          }
          // 2. NEW: Capture tool call arguments! This is where the strict JSON actually streams.
          else if (step.step_type !== "agent_response") {
            // Check common delta fields used by agent tool streams
            let delta = step.text_delta || step.tool_call_delta || step.input_json_delta || step.arguments_delta;
            
            // Handle array-based tool call chunks if agy structures them that way
            if (!delta && Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
                const tc = step.tool_calls[0];
                delta = tc.delta || tc.input_json_delta || tc.arguments_delta || (tc.function && tc.function.arguments);
            }

            if (delta && typeof delta === "string") {
              streamedResponse += delta;
              onMessage?.(delta); 
            }
          }

          if (step.usage) {
            cumulative.inputTokens = step.usage.input_tokens || cumulative.inputTokens;
            cumulative.outputTokens = step.usage.output_tokens || cumulative.outputTokens;
            cumulative.cacheReadTokens = step.usage.cache_read_tokens || cumulative.cacheReadTokens;
          }
        } else if (event.event === "result" && event.result) {
          resultEvent = event.result;
        }
      });

      setupChildProcessHandlers(child, "antigravity", logStream, reject, () => {
        try {
          if (!resultEvent) {
            reject(new Error("Antigravity exited without producing a result event"));
            return;
          }

          if (resultEvent.status === "ERROR") {
            reject(new Error(`Antigravity failed: ${resultEvent.response || "unknown error"}`));
            return;
          }

          if (resultEvent.usage) {
             cumulative.inputTokens = resultEvent.usage.input_tokens || cumulative.inputTokens;
             cumulative.outputTokens = resultEvent.usage.output_tokens || cumulative.outputTokens;
             cumulative.cacheReadTokens = resultEvent.usage.cache_read_tokens || cumulative.cacheReadTokens;
             cumulative.cacheCreationTokens = resultEvent.usage.cache_creation_tokens || cumulative.cacheCreationTokens;
             cumulative.estimated = false;
          }

          let parsed = resultEvent.structured_output;
          
          if (!parsed && streamedResponse) {
            // Fallback 1: Try gnhf's standard markdown extractor
            const extracted = parseAgentJson(streamedResponse);
            if (extracted) {
              parsed = extracted;
            } else {
              // Fallback 2: Tool arguments lack markdown fences. Try parsing the raw string.
              // It might be completely valid JSON that just failed strict schema validation!
              try {
                parsed = JSON.parse(streamedResponse.trim());
              } catch {
                // Fallback 3: It's completely malformed. Wrap it in a graceful failure.
                // We slice the last 500 chars so gnhf logs exactly what the model hallucinated.
                parsed = {
                  success: false,
                  summary: "Agent failed schema validation. Raw output: " + streamedResponse.trim().slice(-500),
                };
              }
            }
          }

          if (!parsed) {
            parsed = {
              success: false,
              summary: "Agent did not return structured output or a response.",
            };
          }

          onUsage?.({ ...cumulative });
          resolve({ output: parsed as unknown as AgentOutput, usage: cumulative });
        } catch (err) {
          reject(new Error(`Failed to parse antigravity output: ${err instanceof Error ? err.message : err}`));
        }
      });
    });
  }
}
