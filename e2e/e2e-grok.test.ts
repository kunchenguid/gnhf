import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
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
const mockGrokPath = join(fixtureBinDir, "mock-grok");

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
  const cwd = mkdtempSync(join(tmpdir(), "gnhf-e2e-grok-repo-"));
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
  if (!existsSync(runsDir)) {
    throw new Error(`No run directory found under ${runsDir}`);
  }
  const runs = readdirSync(runsDir);
  if (runs.length !== 1) {
    throw new Error(
      `Expected exactly one run in ${runsDir}, found ${runs.length}: ${runs.join(", ")}`,
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

function createGrokEnv(
  tempDirs: string[],
  options: {
    mockLogPath: string;
    mode?: "success" | "signed-out";
  },
): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "gnhf-e2e-grok-home-"));
  tempDirs.push(home);
  mkdirSync(join(home, ".gnhf"), { recursive: true });
  writeFileSync(
    join(home, ".gnhf", "config.yml"),
    [
      "agent: grok",
      "preventSleep: false",
      "agentPathOverride:",
      `  grok: ${mockGrokPath}`,
      "",
    ].join("\n"),
    "utf-8",
  );

  return {
    ...process.env,
    ...sanitizedGitEnv,
    HOME: home,
    USERPROFILE: home,
    GNHF_TELEMETRY: "0",
    GNHF_MOCK_GROK_LOG_PATH: options.mockLogPath,
    GNHF_MOCK_GROK_MODE: options.mode ?? "success",
  };
}

// cmd.exe truncates the multi-line argv prompt a .cmd shim would receive.
describe.skipIf(process.platform === "win32")("gnhf e2e grok agent", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function setup(): { cwd: string; mockLogPath: string } {
    chmodSync(mockGrokPath, 0o755);
    const cwd = createRepo();
    tempDirs.push(cwd);
    const logDir = mkdtempSync(join(tmpdir(), "gnhf-e2e-grok-logs-"));
    tempDirs.push(logDir);
    return { cwd, mockLogPath: join(logDir, "mock-grok.jsonl") };
  }

  it("runs --agent grok headless with the model, output schema, and always-approve default", async () => {
    const { cwd, mockLogPath } = setup();

    const result = await runCli(
      cwd,
      [
        "add a hello.txt via grok",
        "--agent",
        "grok",
        "--model",
        "grok-4.5-build",
        "--max-iterations",
        "1",
        "--current-branch",
        "--prevent-sleep",
        "off",
      ],
      { env: createGrokEnv(tempDirs, { mockLogPath }) },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("max iterations reached (1)");
    expect(readFileSync(join(cwd, "hello.txt"), "utf-8")).toBe(
      "hello from grok mock\n",
    );
    expect(git(["rev-list", "--count", "HEAD"], cwd)).toBe("2");
    expect(git(["log", "-1", "--format=%s"], cwd)).toBe(
      "gnhf 1: grok mock wrote hello.txt",
    );

    const spawnEvent = readJsonLines(mockLogPath).find(
      (entry) => entry.event === "spawn",
    );
    expect(spawnEvent?.argv).toEqual([
      "-m",
      "grok-4.5-build",
      "-p",
      "<prompt>",
      "--output-format",
      "streaming-json",
      "--json-schema",
      "<schema>",
      "--always-approve",
    ]);
    expect(spawnEvent?.promptHasObjective).toBe(true);
    expect(spawnEvent?.schemaRequired).toEqual([
      "success",
      "summary",
      "key_changes_made",
      "key_learnings",
    ]);
  }, 30_000);

  it("aborts without retrying when grok is signed out", async () => {
    const { cwd, mockLogPath } = setup();

    const result = await runCli(
      cwd,
      [
        "add a hello.txt via grok",
        "--agent",
        "grok",
        "--current-branch",
        "--prevent-sleep",
        "off",
      ],
      { env: createGrokEnv(tempDirs, { mockLogPath, mode: "signed-out" }) },
    );

    expect(result.stdout).toContain("gnhf stopped");
    expect(result.stdout).toContain("Not signed in");
    expect(
      readJsonLines(mockLogPath).filter((entry) => entry.event === "spawn"),
    ).toHaveLength(1);
    expect(git(["rev-list", "--count", "HEAD"], cwd)).toBe("1");
  }, 30_000);
});
