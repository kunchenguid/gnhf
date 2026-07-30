import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distCliPath = join(repoRoot, "dist", "cli.mjs");
const fixtureBinDir = join(repoRoot, "e2e", "fixtures");

// Empty gitconfig so the developer's real ~/.gitconfig (commit.gpgsign,
// core.hooksPath, credential helpers) cannot affect these runs.
const emptyGitConfigDir = mkdtempSync(
  join(tmpdir(), "gnhf-e2e-grok-gitconfig-"),
);
const emptyGitConfigPath = join(emptyGitConfigDir, "gitconfig");
writeFileSync(emptyGitConfigPath, "", "utf-8");

const sanitizedGitEnv: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: emptyGitConfigPath,
  GIT_CONFIG_SYSTEM: emptyGitConfigPath,
  GIT_TERMINAL_PROMPT: "0",
};

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...sanitizedGitEnv },
  }).trim();
}

function createRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "gnhf-e2e-grok-"));
  git(["init", "-b", "main"], cwd);
  git(["config", "user.name", "gnhf tests"], cwd);
  git(["config", "user.email", "tests@example.com"], cwd);
  writeFileSync(join(cwd, "README.md"), "# fixture\n", "utf-8");
  git(["add", "README.md"], cwd);
  git(["commit", "-m", "init"], cwd);
  return cwd;
}

function readJsonLines(filePath: string): Record<string, unknown>[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function findRunLogPath(cwd: string): string {
  const runsDir = join(cwd, ".gnhf", "runs");
  const runs = readdirSync(runsDir);
  if (runs.length !== 1) {
    throw new Error(
      `Expected exactly one run in ${runsDir}, found ${runs.length}`,
    );
  }
  return join(runsDir, runs[0]!, "gnhf.log");
}

function runCli(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [distCliPath, ...args], {
      cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolveResult({ code, signal, stdout, stderr });
    });
    child.stdin.end();
  });
}

function createTestEnv(
  mockLogPath: string,
  tempDirs: string[],
): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "gnhf-e2e-grok-home-"));
  tempDirs.push(home);

  return {
    ...process.env,
    ...sanitizedGitEnv,
    HOME: home,
    USERPROFILE: home,
    PATH: `${fixtureBinDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    GNHF_MOCK_GROK_LOG_PATH: mockLogPath,
  };
}

function readMockInvocations(
  mockLogPath: string,
): { argv: string[]; prompt: string; schema: string; cwd: string }[] {
  return readJsonLines(mockLogPath)
    .filter((entry) => entry.event === "cli:invoked")
    .map((entry) => ({
      argv: entry.argv as string[],
      prompt: String(entry.prompt),
      schema: String(entry.schema),
      cwd: String(entry.cwd),
    }));
}

describe("gnhf grok e2e", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 200,
        });
      } catch {
        // Windows: child processes may briefly hold file locks after exit
      }
    }
  });

  it("runs an iteration through the grok CLI wire format and commits the result", async () => {
    const cwd = createRepo();
    tempDirs.push(cwd);
    const logDir = mkdtempSync(join(tmpdir(), "gnhf-e2e-grok-logs-"));
    tempDirs.push(logDir);
    const mockLogPath = join(logDir, "mock-grok.jsonl");

    const result = await runCli(
      cwd,
      ["add a line to the readme", "--agent", "grok", "--max-iterations", "1"],
      { env: createTestEnv(mockLogPath, tempDirs) },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("gnhf stopped");
    expect(result.stdout).toContain("grok ran");
    expect(result.stdout).toContain("max iterations reached (1)");
    // Usage from the terminal `end` event: 1200 fresh + 300 cache-read input,
    // and 150 reasoning tokens that `total_tokens` shows sit outside
    // `output_tokens` (450 + 150 = 600). Authoritative, so no "~" prefix.
    expect(result.stdout).toContain("2K in");
    expect(result.stdout).toContain("600 out");
    expect(result.stdout).not.toContain("~2K in");

    expect(git(["rev-list", "--count", "HEAD"], cwd)).toBe("2");
    expect(git(["log", "-1", "--format=%s"], cwd)).toContain("gnhf 1:");
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).toContain("gnhf/");
    expect(readFileSync(join(cwd, "README.md"), "utf-8")).toContain(
      "- grok change",
    );

    const invocations = readMockInvocations(mockLogPath);
    expect(invocations).toHaveLength(1);
    const invocation = invocations[0]!;
    expect(invocation.prompt).toContain("add a line to the readme");
    expect(invocation.argv).toContain("-p");
    expect(invocation.argv).toContain("--always-approve");
    expect(invocation.argv.join(" ")).toContain(
      "--output-format streaming-json",
    );
    expect(JSON.parse(invocation.schema)).toMatchObject({
      type: "object",
      required: ["success", "summary", "key_changes_made", "key_learnings"],
    });

    const debugEntries = readJsonLines(findRunLogPath(cwd));
    const debugEvents = debugEntries.map((entry) => entry.event);
    expect(debugEvents).toContain("agent:run:start");
    expect(debugEvents).toContain("agent:run:end");
    expect(debugEvents).toContain("run:complete");
    expect(
      debugEntries.find((entry) => entry.event === "iteration:end")?.success,
    ).toBe(true);
  }, 30_000);

  it("keeps the finished iteration's commit when its reported usage trips --max-tokens", async () => {
    const cwd = createRepo();
    tempDirs.push(cwd);
    const logDir = mkdtempSync(join(tmpdir(), "gnhf-e2e-grok-logs-"));
    tempDirs.push(logDir);
    const mockLogPath = join(logDir, "mock-grok.jsonl");

    // grok only reports usage in the terminal `end` event, so a low
    // --max-tokens budget must not roll back the iteration that just
    // finished: the work is committed, then the run stops.
    const result = await runCli(
      cwd,
      [
        "add a line to the readme",
        "--agent",
        "grok",
        "--max-iterations",
        "5",
        "--max-tokens",
        "100",
      ],
      { env: createTestEnv(mockLogPath, tempDirs) },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("max tokens reached (2100/100)");
    expect(git(["rev-list", "--count", "HEAD"], cwd)).toBe("2");
    expect(readFileSync(join(cwd, "README.md"), "utf-8")).toContain(
      "- grok change",
    );
    expect(readMockInvocations(mockLogPath)).toHaveLength(1);

    const debugEntries = readJsonLines(findRunLogPath(cwd));
    expect(debugEntries.map((entry) => entry.event)).not.toContain(
      "agent:run:aborted",
    );
    expect(
      debugEntries.find((entry) => entry.event === "iteration:end")?.success,
    ).toBe(true);
  }, 30_000);

  it("recovers the iteration output when grok only prints JSON as text", async () => {
    const cwd = createRepo();
    tempDirs.push(cwd);
    const logDir = mkdtempSync(join(tmpdir(), "gnhf-e2e-grok-logs-"));
    tempDirs.push(logDir);
    const mockLogPath = join(logDir, "mock-grok.jsonl");

    const result = await runCli(
      cwd,
      ["add a line to the readme", "--agent", "grok", "--max-iterations", "1"],
      {
        env: {
          ...createTestEnv(mockLogPath, tempDirs),
          GNHF_MOCK_GROK_TEXT_ONLY: "1",
        },
      },
    );

    expect(result.code).toBe(0);
    expect(git(["rev-list", "--count", "HEAD"], cwd)).toBe("2");
    expect(git(["log", "-1", "--format=%s"], cwd)).toContain("gnhf 1:");

    const notesPath = join(dirname(findRunLogPath(cwd)), "notes.md");
    expect(readFileSync(notesPath, "utf-8")).toContain(
      "appended a mock grok change to README.md",
    );
  }, 30_000);
});
