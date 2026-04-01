import { readFileSync } from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline";
import { Command, InvalidArgumentError } from "commander";
import { loadConfig } from "./core/config.js";
import {
  ensureCleanWorkingTree,
  createBranch,
  getHeadCommit,
  getCurrentBranch,
} from "./core/git.js";
import {
  type RunInfo,
  setupRun,
  resumeRun,
  getLastIterationNumber,
} from "./core/run.js";
import { createAgent } from "./core/agents/factory.js";
import { Orchestrator } from "./core/orchestrator.js";
import { MockOrchestrator } from "./mock-orchestrator.js";
import { Renderer } from "./renderer.js";
import { slugifyPrompt } from "./utils/slugify.js";

const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
).version as string;
const FORCE_EXIT_TIMEOUT_MS = 5_000;

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

const program = new Command();

program
  .name("gnhf")
  .description("Before I go to bed, I tell my agents: good night, have fun")
  .version(packageVersion)
  .argument("[prompt]", "The objective for the coding agent")
  .option("--agent <agent>", "Agent to use (claude, codex, or rovodev)")
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
  .option("--mock", "", false)
  .action(
    async (
      promptArg: string | undefined,
      options: {
        agent?: string;
        maxIterations?: number;
        maxTokens?: number;
        mock: boolean;
      },
    ) => {
      if (options.mock) {
        const mock = new MockOrchestrator();
        enterAltScreen();
        const renderer = new Renderer(
          mock as unknown as Orchestrator,
          "let's minimize app startup latency without sacrificing any functionality",
          "mock",
        );
        renderer.start();
        mock.start();
        await renderer.waitUntilExit();
        exitAltScreen();
        return;
      }
      let prompt = promptArg;

      if (!prompt && !process.stdin.isTTY) {
        prompt = readFileSync("/dev/stdin", "utf-8").trim();
      }

      const agentName = options.agent;
      if (
        agentName !== undefined &&
        agentName !== "claude" &&
        agentName !== "codex" &&
        agentName !== "rovodev"
      ) {
        console.error(
          `Unknown agent: ${options.agent}. Use "claude", "codex", or "rovodev".`,
        );
        process.exit(1);
      }

      const config = loadConfig(
        agentName
          ? { agent: agentName as "claude" | "codex" | "rovodev" }
          : undefined,
      );
      if (
        config.agent !== "claude" &&
        config.agent !== "codex" &&
        config.agent !== "rovodev"
      ) {
        console.error(
          `Unknown agent: ${config.agent}. Use "claude", "codex", or "rovodev".`,
        );
        process.exit(1);
      }
      const cwd = process.cwd();

      const currentBranch = getCurrentBranch(cwd);
      const onGnhfBranch = currentBranch.startsWith("gnhf/");

      let runInfo;
      let startIteration = 0;

      if (onGnhfBranch) {
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

      const agent = createAgent(config.agent, runInfo);
      const orchestrator = new Orchestrator(
        config,
        agent,
        runInfo,
        prompt,
        cwd,
        startIteration,
        {
          maxIterations: options.maxIterations,
          maxTokens: options.maxTokens,
        },
      );

      enterAltScreen();
      const renderer = new Renderer(orchestrator, prompt, config.agent);
      renderer.start();

      const orchestratorPromise = orchestrator.start().catch((err) => {
        renderer.stop();
        exitAltScreen();
        die(err instanceof Error ? err.message : String(err));
      });

      await renderer.waitUntilExit();
      exitAltScreen();
      const shutdownResult = await Promise.race([
        orchestratorPromise.then(() => "done" as const),
        new Promise<"timeout">((resolve) => {
          setTimeout(() => resolve("timeout"), FORCE_EXIT_TIMEOUT_MS).unref();
        }),
      ]);

      if (shutdownResult === "timeout") {
        console.error(
          `\n  gnhf: shutdown timed out after ${FORCE_EXIT_TIMEOUT_MS / 1000}s, forcing exit\n`,
        );
        process.exit(130);
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
