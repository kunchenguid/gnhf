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

// Empty gitconfig pointed at by GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM so the
// developer's real ~/.gitconfig cannot affect these tests.
const emptyGitConfigDir = mkdtempSync(join(tmpdir(), "gnhf-e2e-gitconfig-"));
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

// The score script is committed into the fixture repo so `git reset --hard`
// after a rejected iteration keeps it around. It scores the workspace by
// README.md byte length: the mock opencode agent appends one marker line per
// iteration, so the score strictly increases while changes are kept.
function createRepo(scoreScript: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "gnhf-e2e-metric-"));
  git(["init", "-b", "main"], cwd);
  git(["config", "user.name", "gnhf tests"], cwd);
  git(["config", "user.email", "tests@example.com"], cwd);
  writeFileSync(join(cwd, "README.md"), "# fixture\n", "utf-8");
  writeFileSync(join(cwd, "score.mjs"), scoreScript, "utf-8");
  git(["add", "README.md", "score.mjs"], cwd);
  git(["commit", "-m", "init"], cwd);
  return cwd;
}

const README_LENGTH_SCORE = [
  'import { readFileSync } from "node:fs";',
  'process.stdout.write(String(readFileSync("README.md", "utf-8").length));',
  "",
].join("\n");

const UNPARSEABLE_SCORE = 'process.stdout.write("not-a-number\\n");\n';

function readJsonLines(filePath: string): Record<string, unknown>[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Each test creates a fresh repo, so there is exactly one run dir. */
function findRunDir(cwd: string): string {
  const runsDir = join(cwd, ".gnhf", "runs");
  const runs = existsSync(runsDir) ? readdirSync(runsDir) : [];
  if (runs.length !== 1) {
    throw new Error(
      `Expected exactly one run in ${runsDir}, found ${runs.length}: ${runs.join(", ")}`,
    );
  }
  return join(runsDir, runs[0]!);
}

function runCli(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  // Promise.withResolvers is unavailable under this repo's TS lib target;
  // the executor form matches the sibling e2e files.
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [distCliPath, ...args], {
      cwd,
      env,
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
  const home = mkdtempSync(join(tmpdir(), "gnhf-e2e-metric-home-"));
  tempDirs.push(home);

  return {
    ...process.env,
    ...sanitizedGitEnv,
    HOME: home,
    USERPROFILE: home,
    PATH: `${fixtureBinDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    GNHF_MOCK_OPENCODE_LOG_PATH: mockLogPath,
  };
}

describe("gnhf metric gate e2e", () => {
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
        // Windows: child processes may still hold file locks briefly after exit
      }
    }
  });

  function setup(scoreScript: string): { cwd: string; mockLogPath: string } {
    const cwd = createRepo(scoreScript);
    tempDirs.push(cwd);
    const logDir = mkdtempSync(join(tmpdir(), "gnhf-e2e-metric-logs-"));
    tempDirs.push(logDir);
    return { cwd, mockLogPath: join(logDir, "mock-opencode.jsonl") };
  }

  it("commits each iteration whose score strictly improves and persists the best metric", async () => {
    const { cwd, mockLogPath } = setup(README_LENGTH_SCORE);

    const result = await runCli(
      cwd,
      [
        "grow the README",
        "--agent",
        "opencode",
        "--max-iterations",
        "2",
        "--score-command",
        "node score.mjs",
        "--score-direction",
        "max",
      ],
      createTestEnv(mockLogPath, tempDirs),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("max iterations reached (2)");
    // init + two gated commits
    expect(git(["rev-list", "--count", "HEAD"], cwd)).toBe("3");
    expect(git(["log", "-1", "--format=%s"], cwd)).toContain("gnhf 2:");

    const runDir = findRunDir(cwd);
    const bestMetric = Number(
      readFileSync(join(runDir, "best-metric"), "utf-8").trim(),
    );
    // Best score persisted after iteration 2 equals the committed README size.
    expect(bestMetric).toBe(readFileSync(join(cwd, "README.md"), "utf-8").length);

    const events = readJsonLines(join(runDir, "gnhf.log")).map(
      (entry) => entry.event,
    );
    expect(events).toContain("metric:gate:accepted");
    expect(events).not.toContain("metric:gate:rejected");
  }, 30_000);

  it("rejects non-improving scores: no commit, worktree reset, run stops after N in a row", async () => {
    const { cwd, mockLogPath } = setup(README_LENGTH_SCORE);

    const result = await runCli(
      cwd,
      [
        "shrink the README",
        "--agent",
        "opencode",
        "--max-iterations",
        "6",
        "--score-command",
        "node score.mjs",
        // The mock agent only ever grows README.md, so with "min" every
        // iteration after the first baseline is strictly worse.
        "--score-direction",
        "min",
        "--stop-after-non-improving",
        "2",
      ],
      createTestEnv(mockLogPath, tempDirs),
    );

    expect(result.code).toBe(0);
    // Distinct metric-gate stop reason, not max-iterations and not the
    // consecutive-failures abort.
    expect(result.stdout).toContain(
      "metric gate: 2 consecutive non-improving iterations",
    );
    expect(result.stdout).not.toContain("max iterations reached");

    // Only the baseline iteration committed: init + 1.
    expect(git(["rev-list", "--count", "HEAD"], cwd)).toBe("2");
    // Rejected iterations were reset: the working tree is clean and README
    // holds exactly the one committed mock change.
    expect(git(["status", "--porcelain"], cwd)).toBe("");
    const readme = readFileSync(join(cwd, "README.md"), "utf-8");
    expect(readme.match(/- mock change /g)).toHaveLength(1);

    const runDir = findRunDir(cwd);
    // Best metric stays the baseline score from the single committed iteration.
    const bestMetric = Number(
      readFileSync(join(runDir, "best-metric"), "utf-8").trim(),
    );
    expect(bestMetric).toBe(readme.length);

    const events = readJsonLines(join(runDir, "gnhf.log")).map(
      (entry) => entry.event,
    );
    expect(events).toContain("metric:gate:accepted");
    expect(events).toContain("metric:gate:rejected");
  }, 30_000);

  it("treats an unparseable score as non-improving without crashing", async () => {
    const { cwd, mockLogPath } = setup(UNPARSEABLE_SCORE);

    const result = await runCli(
      cwd,
      [
        "objective with a broken score command",
        "--agent",
        "opencode",
        "--max-iterations",
        "6",
        "--score-command",
        "node score.mjs",
        "--score-direction",
        "max",
        "--stop-after-non-improving",
        "2",
      ],
      createTestEnv(mockLogPath, tempDirs),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "metric gate: 2 consecutive non-improving iterations",
    );

    // Nothing ever committed and no best metric was recorded.
    expect(git(["rev-list", "--count", "HEAD"], cwd)).toBe("1");
    expect(git(["status", "--porcelain"], cwd)).toBe("");
    const runDir = findRunDir(cwd);
    expect(existsSync(join(runDir, "best-metric"))).toBe(false);

    const events = readJsonLines(join(runDir, "gnhf.log")).map(
      (entry) => entry.event,
    );
    expect(events).toContain("metric:score:parse-failed");
    expect(events).not.toContain("metric:gate:accepted");
  }, 30_000);
});
