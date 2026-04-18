import {
  mkdtempSync,
  readFileSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { Command, InvalidArgumentError } from "commander";
import { loadConfig } from "./core/config.js";
import {
  appendDebugLog,
  initDebugLog,
  serializeError,
} from "./core/debug-log.js";
import {
  ensureCleanWorkingTree,
  createBranch,
  getHeadCommit,
  getCurrentBranch,
  getRepoRootDir,
  createWorktree,
  removeWorktree,
} from "./core/git.js";
import {
  type RunInfo,
  setupRun,
  resumeRun,
  getLastIterationNumber,
} from "./core/run.js";
import { readStdinText } from "./core/stdin.js";
import { startSleepPrevention } from "./core/sleep.js";
import { createAgent } from "./core/agents/factory.js";
import { Orchestrator } from "./core/orchestrator.js";
import { MockOrchestrator } from "./mock-orchestrator.js";
import { Renderer } from "./renderer.js";
import { slugifyPrompt } from "./utils/slugify.js";

const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
).version as string;
const FORCE_EXIT_TIMEOUT_MS = 5_000;
const GNHF_REEXEC_STDIN_PROMPT = "GNHF_REEXEC_STDIN_PROMPT";
const GNHF_REEXEC_STDIN_PROMPT_FILE = "GNHF_REEXEC_STDIN_PROMPT_FILE";
const GNHF_REEXEC_STDIN_PROMPT_DIR_PREFIX = "gnhf-stdin-";
const GNHF_REEXEC_STDIN_PROMPT_FILENAME = "prompt.txt";

function parseNonNegativeInteger(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("must be a non-negative integer");
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError("must be a safe integer");
  }

  return parsed;
}

function parseOnOffBoolean(value: string): boolean {
  if (value === "on" || value === "true") return true;
  if (value === "off" || value === "false") return false;
  throw new InvalidArgumentError(
    'must be one of: "on", "off", "true", "false"',
  );
}

function humanizeErrorMessage(message: string): string {
  if (message.includes("not a git repository")) {
    return 'This command must be run inside a Git repository. Change into a repo or run "git init" first.';
  }

  return message;
}

function initializeNewBranch(prompt: string, cwd: string): RunInfo {
  ensureCleanWorkingTree(cwd);
  const baseCommit = getHeadCommit(cwd);
  const branchName = slugifyPrompt(prompt);
  createBranch(branchName, cwd);
  const runId = branchName.split("/")[1]!;
  return setupRun(runId, prompt, baseCommit, cwd);
}

interface WorktreeRunResult {
  runInfo: RunInfo;
  worktreePath: string;
  effectiveCwd: string;
}

function initializeWorktreeRun(prompt: string, cwd: string): WorktreeRunResult {
  // Intentionally skip ensureCleanWorkingTree() — git worktree add creates
  // an independent working directory from HEAD; uncommitted changes in the
  // main checkout don't carry over, so a dirty tree is harmless here.
  const repoRoot = getRepoRootDir(cwd);
  const baseCommit = getHeadCommit(cwd);
  const branchName = slugifyPrompt(prompt);
  const runId = branchName.split("/")[1]!;
  const worktreePath = join(
    dirname(repoRoot),
    `${basename(repoRoot)}-gnhf-worktrees`,
    runId,
  );
  createWorktree(repoRoot, worktreePath, branchName);
  const runInfo = setupRun(runId, prompt, baseCommit, worktreePath);
  return { runInfo, worktreePath, effectiveCwd: worktreePath };
}

function ask(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

function getSignalExitCode(signal: NodeJS.Signals): number {
  return signal === "SIGINT" ? 130 : 143;
}

function persistStdinPromptForReexec(prompt: string): {
  path: string;
  cleanup: () => void;
} {
  const promptDir = mkdtempSync(
    join(tmpdir(), GNHF_REEXEC_STDIN_PROMPT_DIR_PREFIX),
  );
  const promptPath = join(promptDir, GNHF_REEXEC_STDIN_PROMPT_FILENAME);
  writeFileSync(promptPath, prompt, { encoding: "utf-8", mode: 0o600 });
  return {
    path: promptPath,
    cleanup: () => {
      rmSync(promptDir, { recursive: true, force: true });
    },
  };
}

function isTrustedReexecPromptPath(promptPath: string): boolean {
  const resolvedPromptPath = resolve(promptPath);
  const promptDir = dirname(resolvedPromptPath);
  return (
    basename(resolvedPromptPath) === GNHF_REEXEC_STDIN_PROMPT_FILENAME &&
    dirname(promptDir) === resolve(tmpdir()) &&
    basename(promptDir).startsWith(GNHF_REEXEC_STDIN_PROMPT_DIR_PREFIX)
  );
}

function cleanupTrustedReexecPromptPath(promptPath: string): void {
  if (!isTrustedReexecPromptPath(promptPath)) {
    return;
  }

  const resolvedPromptPath = resolve(promptPath);
  rmSync(resolvedPromptPath, { force: true });
  try {
    rmdirSync(dirname(resolvedPromptPath));
  } catch {
    // Leave the directory in place if anything unexpected remains.
  }
}

function readReexecStdinPrompt(env: NodeJS.ProcessEnv): string | undefined {
  const promptPath = env[GNHF_REEXEC_STDIN_PROMPT_FILE];
  if (promptPath !== undefined) {
    delete env[GNHF_REEXEC_STDIN_PROMPT_FILE];
    try {
      return readFileSync(promptPath, "utf-8");
    } finally {
      cleanupTrustedReexecPromptPath(promptPath);
    }
  }

  const prompt = env[GNHF_REEXEC_STDIN_PROMPT];
  if (prompt !== undefined) {
    delete env[GNHF_REEXEC_STDIN_PROMPT];
    return prompt;
  }

  return undefined;
}

const program = new Command();

program
  .name("gnhf")
  .description("Before I go to bed, I tell my agents: good night, have fun")
  .version(packageVersion)
  .argument("[prompt]", "The objective for the coding agent")
  .option(
    "--agent <agent>",
    "Agent to use (claude, codex, rovodev, or opencode)",
  )
  .option(
    "--max-iterations <n>",
    "Abort after N total iterations",
    parseNonNegativeInteger,
  )
  .option(
    "--max-tokens <n>",
    "Abort after N total input+output tokens",
    parseNonNegativeInteger,
  )
  .option(
    "--stop-when <condition>",
    "End the loop when the agent reports this natural-language condition is met",
  )
  .option(
    "--prevent-sleep <mode>",
    'Prevent system sleep during the run ("on" or "off")',
    parseOnOffBoolean,
  )
  .option(
    "--worktree",
    "Run in a separate git worktree (enables multiple agents on the same repo)",
    false,
  )
  .option("--mock", "", false)
  .action(
    async (
      promptArg: string | undefined,
      options: {
        agent?: string;
        maxIterations?: number;
        maxTokens?: number;
        stopWhen?: string;
        preventSleep?: boolean;
        worktree: boolean;
        mock: boolean;
      },
    ) => {
      if (options.mock) {
        const mock = new MockOrchestrator();
        enterAltScreen();
        const renderer = new Renderer(
          mock as unknown as Orchestrator,
          "let's minimize app startup latency without sacrificing any functionality",
          "claude",
        );
        renderer.start();
        mock.start();
        await renderer.waitUntilExit();
        exitAltScreen();
        return;
      }
      let initialSleepPrevention: Awaited<
        ReturnType<typeof startSleepPrevention>
      > | null = null;
      if (process.env.GNHF_SLEEP_INHIBITED === "1") {
        initialSleepPrevention = await startSleepPrevention(
          process.argv.slice(2),
        );
      }
      let prompt = promptArg;
      let promptFromStdin = false;

      const agentName = options.agent;
      if (
        agentName !== undefined &&
        agentName !== "claude" &&
        agentName !== "codex" &&
        agentName !== "rovodev" &&
        agentName !== "opencode"
      ) {
        console.error(
          `Unknown agent: ${options.agent}. Use "claude", "codex", "rovodev", or "opencode".`,
        );
        process.exit(1);
      }

      const loadedConfig = loadConfig(
        agentName
          ? {
              agent: agentName as "claude" | "codex" | "rovodev" | "opencode",
            }
          : {},
      );
      const config = {
        ...loadedConfig,
        ...(options.preventSleep === undefined
          ? {}
          : { preventSleep: options.preventSleep }),
      };
      if (
        config.agent !== "claude" &&
        config.agent !== "codex" &&
        config.agent !== "rovodev" &&
        config.agent !== "opencode"
      ) {
        console.error(
          `Unknown agent: ${config.agent}. Use "claude", "codex", "rovodev", or "opencode".`,
        );
        process.exit(1);
      }

      if (!prompt && process.env.GNHF_SLEEP_INHIBITED === "1") {
        prompt = readReexecStdinPrompt(process.env);
      }
      if (!prompt && !process.stdin.isTTY) {
        prompt = await readStdinText(process.stdin);
        promptFromStdin = true;
      }

      const cwd = process.cwd();
      let effectiveCwd = cwd;
      let worktreePath: string | null = null;
      let worktreeCleanup: (() => void) | null = null;

      const currentBranch = getCurrentBranch(cwd);
      const onGnhfBranch = currentBranch.startsWith("gnhf/");

      let runInfo;
      let startIteration = 0;

      if (options.worktree) {
        if (!prompt) {
          program.help();
          return;
        }

        if (onGnhfBranch) {
          console.error(
            "Cannot use --worktree from a gnhf branch. Switch to the base branch first.",
          );
          process.exit(1);
        }

        const wt = initializeWorktreeRun(prompt, cwd);
        runInfo = wt.runInfo;
        effectiveCwd = wt.effectiveCwd;
        worktreePath = wt.worktreePath;
        worktreeCleanup = () => {
          try {
            removeWorktree(cwd, wt.worktreePath);
          } catch {
            // Best-effort cleanup
          }
        };

        // Ensure worktree cleanup runs even if die() or process.exit() is
        // called before reaching the normal cleanup block (e.g. orchestrator
        // crash → .catch → die → process.exit(1)).
        const exitCleanup = worktreeCleanup;
        process.on("exit", () => {
          if (worktreeCleanup === exitCleanup) {
            exitCleanup();
          }
        });
      } else if (onGnhfBranch) {
        const existingRunId = currentBranch.slice("gnhf/".length);
        const existing = resumeRun(existingRunId, cwd);
        const existingPrompt = readFileSync(existing.promptPath, "utf-8");

        if (!prompt || prompt === existingPrompt) {
          prompt = existingPrompt;
          runInfo = existing;
          startIteration = getLastIterationNumber(existing);
        } else {
          const answer = await ask(
            `You are on gnhf branch "${currentBranch}".\n` +
              `  (o) Overwrite current run with new prompt\n` +
              `  (n) Start a new branch on top of this one\n` +
              `  (q) Quit\n` +
              `Choose [o/n/q]: `,
          );

          if (answer === "o") {
            ensureCleanWorkingTree(cwd);
            runInfo = setupRun(existingRunId, prompt, existing.baseCommit, cwd);
          } else if (answer === "n") {
            runInfo = initializeNewBranch(prompt, cwd);
          } else {
            process.exit(0);
          }
        }
      } else {
        if (!prompt) {
          program.help();
          return;
        }

        runInfo = initializeNewBranch(prompt, cwd);
      }

      let sleepPreventionCleanup: (() => Promise<void>) | null = null;
      if (config.preventSleep) {
        const persistedPrompt =
          promptFromStdin && prompt !== undefined
            ? persistStdinPromptForReexec(prompt)
            : null;
        let reexeced = false;
        try {
          const sleepPrevention =
            initialSleepPrevention ??
            (await startSleepPrevention(process.argv.slice(2), {
              reexecEnv: persistedPrompt
                ? {
                    [GNHF_REEXEC_STDIN_PROMPT_FILE]: persistedPrompt.path,
                  }
                : undefined,
            }));
          if (sleepPrevention.type === "reexeced") {
            reexeced = true;
            process.exit(sleepPrevention.exitCode);
          }
          if (sleepPrevention.type === "active") {
            sleepPreventionCleanup = sleepPrevention.cleanup;
          }
        } finally {
          if (!reexeced) {
            persistedPrompt?.cleanup();
          }
        }
      }

      initDebugLog(runInfo.logPath);
      appendDebugLog("run:start", {
        args: process.argv.slice(2),
        runId: runInfo.runId,
        runDir: runInfo.runDir,
        agent: config.agent,
        promptLength: prompt.length,
        promptFromStdin,
        startIteration,
        maxIterations: options.maxIterations,
        maxTokens: options.maxTokens,
        stopWhen: options.stopWhen,
        preventSleep: config.preventSleep,
        agentArgsOverride: config.agentArgsOverride?.[config.agent],
        worktree: options.worktree,
        worktreePath,
        platform: process.platform,
        nodeVersion: process.version,
        gnhfVersion: packageVersion,
      });

      const agent = createAgent(
        config.agent,
        runInfo,
        config.agentPathOverride[config.agent],
        config.agentArgsOverride?.[config.agent],
      );
      const orchestrator = new Orchestrator(
        config,
        agent,
        runInfo,
        prompt,
        effectiveCwd,
        startIteration,
        {
          maxIterations: options.maxIterations,
          maxTokens: options.maxTokens,
          stopWhen: options.stopWhen,
        },
      );
      let shutdownSignal: NodeJS.Signals | null = null;

      enterAltScreen();
      const renderer = new Renderer(orchestrator, prompt, config.agent);
      renderer.start();

      const requestShutdown = (signal: NodeJS.Signals) => {
        if (shutdownSignal) return;
        shutdownSignal = signal;
        appendDebugLog(`signal:${signal}`);
        renderer.stop();
        orchestrator.stop();
      };
      const handleSigInt = () => requestShutdown("SIGINT");
      const handleSigTerm = () => requestShutdown("SIGTERM");
      process.on("SIGINT", handleSigInt);
      process.on("SIGTERM", handleSigTerm);

      const orchestratorPromise = orchestrator
        .start()
        .finally(() => {
          const keepTui =
            orchestrator.getState().status === "aborted" && process.stdin.isTTY;
          if (!keepTui) {
            renderer.stop();
          }
        })
        .catch((err) => {
          appendDebugLog("orchestrator:fatal", {
            error: serializeError(err),
          });
          exitAltScreen();
          die(err instanceof Error ? err.message : String(err));
        });

      try {
        const rendererExitReason = await renderer.waitUntilExit();
        if (rendererExitReason === "interrupted" && !shutdownSignal) {
          shutdownSignal = "SIGINT";
          appendDebugLog("signal:SIGINT");
        }
        exitAltScreen();
        const shutdownResult = await Promise.race([
          orchestratorPromise.then(() => "done" as const),
          new Promise<"timeout">((resolve) => {
            setTimeout(() => resolve("timeout"), FORCE_EXIT_TIMEOUT_MS).unref();
          }),
        ]);

        if (shutdownResult === "timeout") {
          appendDebugLog("run:shutdown-timeout", {
            timeoutMs: FORCE_EXIT_TIMEOUT_MS,
          });
          console.error(
            `\n  gnhf: shutdown timed out after ${FORCE_EXIT_TIMEOUT_MS / 1000}s, forcing exit\n`,
          );
          process.exit(getSignalExitCode(shutdownSignal ?? "SIGINT"));
        }
      } finally {
        process.off("SIGINT", handleSigInt);
        process.off("SIGTERM", handleSigTerm);
        await sleepPreventionCleanup?.();
      }

      {
        const finalState = orchestrator.getState();
        appendDebugLog("run:complete", {
          signal: shutdownSignal,
          status: finalState.status,
          iterations: finalState.currentIteration,
          successCount: finalState.successCount,
          failCount: finalState.failCount,
          totalInputTokens: finalState.totalInputTokens,
          totalOutputTokens: finalState.totalOutputTokens,
          commitCount: finalState.commitCount,
          worktreePath,
        });

        if (worktreePath) {
          if (finalState.commitCount > 0) {
            worktreeCleanup = null;
            console.error(
              `\n  gnhf: worktree preserved at ${worktreePath}` +
                `\n  gnhf: merge the branch and remove with: git worktree remove "${worktreePath}"\n`,
            );
          } else {
            worktreeCleanup?.();
            worktreeCleanup = null;
            appendDebugLog("worktree:cleaned-up", {
              worktreePath,
            });
          }
        }
      }

      if (shutdownSignal) {
        process.exit(getSignalExitCode(shutdownSignal));
      }
    },
  );

function enterAltScreen() {
  process.stdout.write("\x1b[?1049h");
  process.stdout.write("\x1b[?25l");
}

function exitAltScreen() {
  process.stdout.write("\x1b[?25h");
  process.stdout.write("\x1b[?1049l");
}

function die(message: string): never {
  console.error(`\n  gnhf: ${humanizeErrorMessage(message)}\n`);
  process.exit(1);
}

try {
  await program.parseAsync();
} catch (err) {
  die(err instanceof Error ? err.message : String(err));
}
