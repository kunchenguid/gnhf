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

  constructor(
    schemaPath: string,
    binOrDeps: string | AntigravityAgentDeps = {},
  ) {
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
      let resultEvent: unknown = null;
      const cumulative: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimated: true,
      };

      parseJSONLStream<Record<string, unknown>>(child.stdout!, logStream, (event) => {
        if (event.event === "step_update" && event.step_update) {
          const step = event.step_update;

          let delta = "";

          // 1. Capture standard text and tool deltas indiscriminately
          if (typeof step.text_delta === "string") delta += step.text_delta;
          if (typeof step.tool_call_delta === "string")
            delta += step.tool_call_delta;
          if (typeof step.input_json_delta === "string")
            delta += step.input_json_delta;
          if (typeof step.arguments_delta === "string")
            delta += step.arguments_delta;

          // 2. Safely capture array-based tool calls
          if (Array.isArray(step.tool_calls)) {
            for (const tc of step.tool_calls) {
              if (typeof tc.delta === "string") delta += tc.delta;
              if (typeof tc.input_json_delta === "string")
                delta += tc.input_json_delta;
              if (typeof tc.arguments_delta === "string")
                delta += tc.arguments_delta;
              if (tc.function && typeof tc.function.arguments === "string") {
                delta += tc.function.arguments;
              }
            }
          }

          // 3. NEW: Capture Antigravity's specific `tool_info` payload (July 28 Update)
          if (step.tool_info && step.tool_info.parameters) {
            try {
              const paramsStr =
                typeof step.tool_info.parameters === "string"
                  ? step.tool_info.parameters
                  : JSON.stringify(step.tool_info.parameters);
              // Pad with newlines so concatenated tools don't smash into each other
              delta += "\n" + paramsStr + "\n";
            } catch {
              // ignore
            }
          }

          // 4. NEW: Capture Antigravity's subagent_info (July 28 Update)
          if (step.subagent_info) {
            try {
              const subagentStr =
                typeof step.subagent_info === "string"
                  ? step.subagent_info
                  : JSON.stringify(step.subagent_info);
              delta += "\n" + subagentStr + "\n";
            } catch {
              // ignore
            }
          }

          if (delta) {
            streamedResponse += delta;
            onMessage?.(delta);
          }

          if (step.usage) {
            cumulative.inputTokens =
              step.usage.input_tokens || cumulative.inputTokens;
            cumulative.outputTokens =
              step.usage.output_tokens || cumulative.outputTokens;
            cumulative.cacheReadTokens =
              step.usage.cache_read_tokens || cumulative.cacheReadTokens;
          }
        } else if (event.event === "result" && event.result) {
          resultEvent = event.result;
        }
      });

      setupChildProcessHandlers(child, "antigravity", logStream, reject, () => {
        try {
          if (!resultEvent) {
            reject(
              new Error("Antigravity exited without producing a result event"),
            );
            return;
          }

          if (resultEvent.status === "ERROR") {
            reject(
              new Error(
                `Antigravity failed: ${resultEvent.response || "unknown error"}`,
              ),
            );
            return;
          }

          if (resultEvent.usage) {
            cumulative.inputTokens =
              resultEvent.usage.input_tokens || cumulative.inputTokens;
            cumulative.outputTokens =
              resultEvent.usage.output_tokens || cumulative.outputTokens;
            cumulative.cacheReadTokens =
              resultEvent.usage.cache_read_tokens || cumulative.cacheReadTokens;
            cumulative.cacheCreationTokens =
              resultEvent.usage.cache_creation_tokens ||
              cumulative.cacheCreationTokens;
            cumulative.estimated = false;
          }

          let parsed = resultEvent.structured_output;

          if (!parsed && streamedResponse) {
            let extracted = parseAgentJson(streamedResponse);

            // If gnhf's default extractor returns its generic failure, ignore it so we can extract the raw JSON!
            if (
              extracted &&
              extracted.success === false &&
              extracted.summary === "Agent did not return structured output."
            ) {
              extracted = null;
            }

            if (extracted) {
              parsed = extracted;
            } else {
              const text = streamedResponse.trim();
              try {
                parsed = JSON.parse(text);
              } catch {
                // Bracket-matching backward search to find the LAST valid JSON object
                // in case multiple tool_info payloads were concatenated into the stream.
                let found = false;
                let openBraces = 0;
                let closeBraces = 0;
                let endIndex = -1;

                for (let i = text.length - 1; i >= 0; i--) {
                  if (text[i] === "}") {
                    if (endIndex === -1) endIndex = i;
                    closeBraces++;
                  } else if (text[i] === "{") {
                    openBraces++;
                    if (openBraces === closeBraces && endIndex !== -1) {
                      try {
                        parsed = JSON.parse(text.substring(i, endIndex + 1));
                        found = true;
                        break;
                      } catch {
                        // Keep searching backward
                      }
                    }
                  }
                }

                if (!found) {
                  parsed = {
                    success: false,
                    summary:
                      "Agent failed schema validation. Raw output: " +
                      text.slice(-1000),
                  };
                }
              }
            }

            // Final safety wrapper: ensure the extracted object has the keys gnhf expects.
            // If it's missing them, gnhf will overwrite our logs!
            if (
              parsed &&
              typeof parsed === "object" &&
              !("success" in parsed && "summary" in parsed)
            ) {
              parsed = {
                success: false,
                summary:
                  "Agent hallucinated invalid schema. Raw JSON: " +
                  JSON.stringify(parsed).slice(-1000),
              };
            }
          }

          if (!parsed) {
            parsed = {
              success: false,
              summary: "Agent did not return structured output or a response.",
            };
          }

          onUsage?.({ ...cumulative });
          resolve({
            output: parsed as unknown as AgentOutput,
            usage: cumulative,
          });
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
