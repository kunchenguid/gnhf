import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdtempSync,
  openSync,
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
import { AGENT_NAMES, loadConfig, type AgentName } from "./core/config.js";
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
  listWorktreePaths,
} from "./core/git.js";
import {
  type RunInfo,
  type RunSchemaOptions,
  setupRun,
  resumeRun,
  peekRunMetadata,
  getLastIterationNumber,
} from "./core/run.js";
import { readStdinText } from "./core/stdin.js";
import { startSleepPrevention } from "./core/sleep.js";
import { createAgent } from "./core/agents/factory.js";
import {
  getCommitMessageSchemaFields,
  type CommitMessageConfig,
} from "./core/commit-message.js";
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
const AGENT_NAME_SET = new Set<string>(AGENT_NAMES);
const AGENT_NAME_LIST = `"${AGENT_NAMES.slice(0, -1).join('", "')}", or "${
  AGENT_NAMES[AGENT_NAMES.length - 1]
}"`;

class PromptSignalError extends Error {
  constructor(public readonly signal: NodeJS.Signals) {
    super(signal);
  }
}

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

function isAgentName(name: string): name is AgentName {
  return AGENT_NAME_SET.has(name);
}

function buildSchemaOptions(
  stopWhen: string | undefined,
  commitMessage: CommitMessageConfig | undefined,
): RunSchemaOptions {
  const commitFields = getCommitMessageSchemaFields(commitMessage);
  return {
    includeStopField: stopWhen !== undefined,
    ...(stopWhen === undefined ? {} : { stopWhen }),
    ...(commitMessage === undefined ? {} : { commitMessage }),
    ...(commitFields.length === 0 ? {} : { commitFields }),
  };
}

function buildResumeSchemaOptions(
  stopWhen: string | undefined,
  commitMessage: CommitMessageConfig | undefined,
): RunSchemaOptions {
  const commitFields = getCommitMessageSchemaFields(commitMessage);
  if (stopWhen === "") {
    return {
      includeStopField: false,
      clearStopWhen: true,
      ...(commitMessage === undefined ? {} : { commitMessage }),
      ...(commitFields.length === 0 ? {} : { commitFields }),
    };
  }
  return buildSchemaOptions(stopWhen, commitMessage);
}

function initializeNewBranch(
  prompt: string,
  cwd: string,
  schemaOptions: RunSchemaOptions,
): RunInfo {
  ensureCleanWorkingTree(cwd);
  const baseCommit = getHeadCommit(cwd);
  const branchName = createBranchWithSuffix(slugifyPrompt(prompt), cwd);
  const runId = branchName.split("/")[1]!;
  return setupRun(runId, prompt, baseCommit, cwd, schemaOptions);
}

function branchNameWithSuffix(branchName: string, suffix: number): string {
  return suffix === 0 ? branchName : `${branchName}-${suffix}`;
}

function isCollisionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already exists|exists already|would be overwritten/i.test(message);
}

function createBranchWithSuffix(branchName: string, cwd: string): string {
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = branchNameWithSuffix(branchName, suffix);
    try {
      createBranch(candidate, cwd);
      return candidate;
    } catch (error) {
      if (!isCollisionError(error)) throw error;
    }
  }
  throw new Error(`Unable to create a unique branch name for ${branchName}`);
}

interface WorktreeRunResult {
  runInfo: RunInfo;
  worktreePath: string;
  effectiveCwd: string;
  resumed: boolean;
}

function initializeWorktreeRun(
  prompt: string,
  cwd: string,
  schemaOptions: RunSchemaOptions,
  resumeSchemaOptions: RunSchemaOptions,
): WorktreeRunResult {
  // Intentionally skip ensureCleanWorkingTree() — git worktree add creates
  // an independent working directory from HEAD; uncommitted changes in the
  // main checkout don't carry over, so a dirty tree is harmless here.
  const repoRoot = getRepoRootDir(cwd);
  const baseCommit = getHeadCommit(cwd);
  const branchName = slugifyPrompt(prompt);
  const makeWorktreePath = (runId: string) =>
    join(dirname(repoRoot), `${basename(repoRoot)}-gnhf-worktrees`, runId);
  const runId = branchName.split("/")[1]!;
  const worktreePath = makeWorktreePath(runId);
  const registeredWorktreePaths = listWorktreePaths(repoRoot);

  const resumePreservedWorktree = (
    candidateBranchName: string,
    candidateRunId: string,
    candidateWorktreePath: string,
  ): WorktreeRunResult | null => {
    if (
      !registeredWorktreePaths.has(resolve(candidateWorktreePath)) ||
      !existsSync(join(candidateWorktreePath, ".gnhf", "runs", candidateRunId))
    ) {
      return null;
    }

    let worktreeBranch: string;
    try {
      worktreeBranch = getCurrentBranch(candidateWorktreePath);
    } catch (error) {
      throw new Error(
        `Preserved worktree at ${candidateWorktreePath} is in an unexpected state ` +
          `(${error instanceof Error ? error.message : String(error)}). ` +
          `Fix the worktree manually or remove it with ` +
          `"git worktree remove ${candidateWorktreePath}" before re-running.`,
      );
    }
    if (worktreeBranch !== candidateBranchName) {
      throw new Error(
        `Preserved worktree at ${candidateWorktreePath} is on branch ` +
          `"${worktreeBranch}" rather than "${candidateBranchName}". ` +
          `Restore it to "${candidateBranchName}" with "git -C ${candidateWorktreePath} ` +
          `checkout ${candidateBranchName}", or remove the worktree with ` +
          `"git worktree remove ${candidateWorktreePath}" to start fresh.`,
      );
    }
    const runInfo = resumeRun(
      candidateRunId,
      candidateWorktreePath,
      resumeSchemaOptions,
    );
    return {
      runInfo,
      worktreePath: candidateWorktreePath,
      effectiveCwd: candidateWorktreePath,
      resumed: true,
    };
  };

  let createdBranchName = branchName;
  let createdRunId = runId;
  let createdWorktreePath = worktreePath;
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidateBranchName = branchNameWithSuffix(branchName, suffix);
    const candidateRunId = candidateBranchName.split("/")[1]!;
    const candidateWorktreePath = makeWorktreePath(candidateRunId);
    const resumed = resumePreservedWorktree(
      candidateBranchName,
      candidateRunId,
      candidateWorktreePath,
    );
    if (resumed) return resumed;
  }
  for (let suffix = 0; suffix < 100; suffix += 1) {
    createdBranchName = branchNameWithSuffix(branchName, suffix);
    createdRunId = createdBranchName.split("/")[1]!;
    createdWorktreePath = makeWorktreePath(createdRunId);
    const resumed = resumePreservedWorktree(
      createdBranchName,
      createdRunId,
      createdWorktreePath,
    );
    if (resumed) return resumed;
    try {
      createWorktree(repoRoot, createdWorktreePath, createdBranchName);
      break;
    } catch (error) {
      if (!isCollisionError(error)) throw error;
      if (suffix === 99) {
        throw new Error(`Unable to create a unique worktree for ${branchName}`);
      }
    }
  }
  const runInfo = setupRun(
    createdRunId,
    prompt,
    baseCommit,
    createdWorktreePath,
    schemaOptions,
  );
  return {
    runInfo,
    worktreePath: createdWorktreePath,
    effectiveCwd: createdWorktreePath,
    resumed: false,
  };
}

function openPromptTerminal(): {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  cleanup: () => void;
} {
  if (process.stdin.isTTY) {
    return {
      input: process.stdin,
      output: process.stderr,
      cleanup: () => {},
    };
  }

  const inputPath = process.platform === "win32" ? "CONIN$" : "/dev/tty";
  const outputPath = process.platform === "win32" ? "CONOUT$" : "/dev/tty";
  const inputFd = openSync(inputPath, "r");
  try {
    const outputFd = openSync(outputPath, "w");
    try {
      const input = createReadStream("", { autoClose: true, fd: inputFd });
      const output = createWriteStream("", { autoClose: true, fd: outputFd });
      return {
        input,
        output,
        cleanup: () => {
          input.destroy();
          output.destroy();
        },
      };
    } catch (error) {
      closeSync(outputFd);
      throw error;
    }
  } catch (error) {
    closeSync(inputFd);
    throw error;
  }
}

function ask(
  question: string,
  closeMessage: string,
  unavailableMessage: string,
): Promise<string> {
  let terminal;
  try {
    terminal = openPromptTerminal();
  } catch {
    throw new Error(unavailableMessage);
  }

  const rl = createInterface({
    input: terminal.input,
    output: terminal.output,
  });
  return new Promise((resolve, reject) => {
    const handleClose = () => {
      terminal.cleanup();
      rl.off("close", handleClose);
      rl.off("SIGINT", handleSigInt);
      reject(new Error(closeMessage));
    };

    const handleSigInt = () => {
      rl.off("close", handleClose);
      rl.off("SIGINT", handleSigInt);
      rl.close();
      terminal.cleanup();
      reject(new PromptSignalError("SIGINT"));
    };

    rl.once("close", handleClose);
    rl.once("SIGINT", handleSigInt);
    rl.question(question, (answer) => {
      rl.off("close", handleClose);
      rl.off("SIGINT", handleSigInt);
      rl.close();
      terminal.cleanup();
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
  .option("--agent <agent>", `Agent to use (${AGENT_NAMES.join(", ")})`)
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
    'End when the agent reports this condition; resumes reuse it, pass a new value to overwrite or "" to clear',
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
          () => {
            mock.handleInterrupt();
          },
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
      if (agentName !== undefined && !isAgentName(agentName)) {
        console.error(
          `Unknown agent: ${options.agent}. Use ${AGENT_NAME_LIST}.`,
        );
        process.exit(1);
      }

      const loadedConfig = loadConfig(
        agentName
          ? {
              agent: agentName,
            }
          : {},
      );
      const config = {
        ...loadedConfig,
        ...(options.preventSleep === undefined
          ? {}
          : { preventSleep: options.preventSleep }),
      };
      if (!isAgentName(config.agent)) {
        console.error(
          `Unknown agent: ${config.agent}. Use ${AGENT_NAME_LIST}.`,
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

      const cliStopWhen =
        options.stopWhen === "" ? undefined : options.stopWhen;
      let effectiveStopWhen = cliStopWhen;
      let effectiveCommitMessage = config.commitMessage;
      let schemaOptions = buildSchemaOptions(
        effectiveStopWhen,
        effectiveCommitMessage,
      );

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

        const wt = initializeWorktreeRun(
          prompt,
          cwd,
          schemaOptions,
          buildResumeSchemaOptions(options.stopWhen, effectiveCommitMessage),
        );
        runInfo = wt.runInfo;
        effectiveCwd = wt.effectiveCwd;
        worktreePath = wt.worktreePath;

        if (wt.resumed) {
          // Preserved worktree is always kept on exit regardless of this
          // invocation's commit count; previous commits are already there.
          effectiveStopWhen = runInfo.stopWhen;
          effectiveCommitMessage = runInfo.commitMessage;
          schemaOptions = buildSchemaOptions(
            effectiveStopWhen,
            effectiveCommitMessage,
          );
          startIteration = getLastIterationNumber(runInfo);
          console.error(
            `\n  gnhf: resuming preserved worktree at ${worktreePath}` +
              `\n  gnhf: continuing run ${runInfo.runId} from iteration ${startIteration}\n`,
          );
        } else {
          worktreeCleanup = () => {
            try {
              removeWorktree(cwd, wt.worktreePath);
            } catch {
              // Best-effort cleanup
            }
          };

          // Ensure worktree cleanup runs even if die() or process.exit() is
          // called before reaching the normal cleanup block (e.g. orchestrator
          // crash to .catch to die to process.exit(1)).
          const exitCleanup = worktreeCleanup;
          process.on("exit", () => {
            if (worktreeCleanup === exitCleanup) {
              exitCleanup();
            }
          });
        }
      } else if (onGnhfBranch) {
        const existingRunId = currentBranch.slice("gnhf/".length);
        const existingMetadata = peekRunMetadata(existingRunId, cwd);
        effectiveCommitMessage = existingMetadata.commitMessage;
        const existingPrompt = readFileSync(
          existingMetadata.promptPath,
          "utf-8",
        );

        if (!prompt || prompt === existingPrompt) {
          const existing = resumeRun(
            existingRunId,
            cwd,
            buildResumeSchemaOptions(
              options.stopWhen,
              existingMetadata.commitMessage,
            ),
          );
          const resumeStopWhen = existing.stopWhen;
          const resumeSchemaOptions = buildSchemaOptions(
            resumeStopWhen,
            existing.commitMessage,
          );
          prompt = existingPrompt;
          runInfo = existing;
          effectiveStopWhen = resumeStopWhen;
          effectiveCommitMessage = existing.commitMessage;
          schemaOptions = resumeSchemaOptions;
          startIteration = getLastIterationNumber(existing);
        } else {
          const answer = await ask(
            `You are on gnhf branch "${currentBranch}".\n` +
              `  (o) Update prompt and continue current run\n` +
              `  (n) Start a new branch on top of this one\n` +
              `  (q) Quit\n` +
              `Choose [o/n/q]: `,
            "The overwrite prompt closed before a choice was entered. Re-run gnhf from an interactive terminal and choose o, n, or q.",
            "Cannot show the overwrite prompt because stdin is not interactive. Re-run gnhf from an interactive terminal and choose o, n, or q.",
          );

          if (answer === "o") {
            ensureCleanWorkingTree(cwd);
            const existing = resumeRun(
              existingRunId,
              cwd,
              buildResumeSchemaOptions(
                options.stopWhen,
                existingMetadata.commitMessage,
              ),
            );
            const resumeStopWhen = existing.stopWhen;
            const resumeSchemaOptions = buildSchemaOptions(
              resumeStopWhen,
              existing.commitMessage,
            );
            runInfo = setupRun(
              existingRunId,
              prompt,
              existing.baseCommit,
              cwd,
              resumeSchemaOptions,
            );
            effectiveStopWhen = resumeStopWhen;
            effectiveCommitMessage = existing.commitMessage;
            schemaOptions = resumeSchemaOptions;
            startIteration = getLastIterationNumber(existing);
          } else if (answer === "n") {
            effectiveStopWhen = cliStopWhen;
            effectiveCommitMessage = config.commitMessage;
            schemaOptions = buildSchemaOptions(
              effectiveStopWhen,
              effectiveCommitMessage,
            );
            runInfo = initializeNewBranch(prompt, cwd, schemaOptions);
          } else {
            process.exit(0);
          }
        }
      } else {
        if (!prompt) {
          program.help();
          return;
        }

        runInfo = initializeNewBranch(prompt, cwd, schemaOptions);
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
        stopWhen: effectiveStopWhen,
        commitMessage: effectiveCommitMessage,
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
        schemaOptions,
      );
      const orchestrator = new Orchestrator(
        { ...config, commitMessage: effectiveCommitMessage },
        agent,
        runInfo,
        prompt,
        effectiveCwd,
        startIteration,
        {
          maxIterations: options.maxIterations,
          maxTokens: options.maxTokens,
          stopWhen: effectiveStopWhen,
        },
      );
      let shutdownSignal: NodeJS.Signals | null = null;
      let forceShutdownRequested = false;

      const requestForceShutdown = (signal: NodeJS.Signals) => {
        if (forceShutdownRequested) return;
        forceShutdownRequested = true;
        shutdownSignal = signal;
        appendDebugLog(`signal:${signal}`);
        renderer.stop();
      };
      const handleSigInt = () => {
        const disposition = orchestrator.handleInterrupt();
        if (disposition === "force-stop") {
          requestForceShutdown("SIGINT");
          return;
        }
        if (disposition === "exit") {
          shutdownSignal = "SIGINT";
          appendDebugLog("signal:SIGINT");
          renderer.stop("interrupted");
          return;
        }
        shutdownSignal = "SIGINT";
        appendDebugLog("signal:SIGINT");
      };
      const handleSigTerm = () => {
        orchestrator.stop();
        requestForceShutdown("SIGTERM");
      };

      enterAltScreen();
      const renderer = new Renderer(
        orchestrator,
        prompt,
        config.agent,
        handleSigInt,
      );
      renderer.start();

      process.on("SIGINT", handleSigInt);
      process.on("SIGTERM", handleSigTerm);

      const orchestratorPromise = orchestrator
        .start()
        .finally(() => {
          // Only aborted runs keep the done screen open. Graceful stops should
          // exit as soon as the current iteration and shutdown cleanup finish,
          // but a real abort still deserves the done screen even if a prior
          // ctrl+c already set the eventual SIGINT exit code.
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

        if (finalState.status === "aborted") {
          console.error(`\n  gnhf: Run log: ${runInfo.logPath}\n`);
        }

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
  if (err instanceof PromptSignalError) {
    process.exit(getSignalExitCode(err.signal));
  }
  die(err instanceof Error ? err.message : String(err));
}
