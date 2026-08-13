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
const mockCursorAgentPath = join(
  fixtureBinDir,
  process.platform === "win32" ? "mock-cursor-agent.cmd" : "mock-cursor-agent",
);

const emptyGitConfigDir = mkdtempSync(
  join(tmpdir(), "gnhf-e2e-cursor-gitconfig-"),
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
  const cwd = mkdtempSync(join(tmpdir(), "gnhf-e2e-cursor-repo-"));
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

function createCursorEnv(
  tempDirs: string[],
  options: {
    mockLogPath: string;
    extraConfigYaml?: string;
  },
): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "gnhf-e2e-cursor-home-"));
  tempDirs.push(home);
  mkdirSync(join(home, ".gnhf"), { recursive: true });
  writeFileSync(
    join(home, ".gnhf", "config.yml"),
    [
      "agent: cursor",
      "preventSleep: false",
      "agentPathOverride:",
      `  cursor: ${mockCursorAgentPath}`,
      options.extraConfigYaml ?? "",
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
    GNHF_MOCK_CURSOR_LOG_PATH: options.mockLogPath,
  };
}

describe("gnhf e2e cursor agent", () => {
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
        // Best-effort cleanup on Windows file locks.
      }
    }
  });

  it("runs --agent cursor through stream-json with force/trust/approve-mcps defaults", async () => {
    chmodSync(mockCursorAgentPath, 0o755);
    const cwd = createRepo();
    tempDirs.push(cwd);
    const logDir = mkdtempSync(join(tmpdir(), "gnhf-e2e-cursor-logs-"));
    tempDirs.push(logDir);
    const mockLogPath = join(logDir, "mock-cursor.jsonl");

    const result = await runCli(
      cwd,
      [
        "add a hello.txt via cursor agent",
        "--agent",
        "cursor",
        "--max-iterations",
        "1",
        "--current-branch",
        "--prevent-sleep",
        "off",
      ],
      {
        env: createCursorEnv(tempDirs, { mockLogPath }),
      },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("gnhf stopped");
    expect(result.stdout).toContain("cursor ran");
    expect(result.stdout).toContain("max iterations reached (1)");
    expect(readFileSync(join(cwd, "hello.txt"), "utf-8")).toBe(
      "hello from cursor mock\n",
    );
    expect(git(["rev-list", "--count", "HEAD"], cwd)).toBe("2");
    expect(git(["log", "-1", "--format=%s"], cwd)).toContain("gnhf 1:");

    const spawnEvent = readJsonLines(mockLogPath).find(
      (entry) => entry.event === "spawn",
    );
    expect(spawnEvent).toBeDefined();
    expect(spawnEvent?.argv).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--force",
      "--trust",
      "--approve-mcps",
    ]);
    expect(spawnEvent?.hasSchemaContract).toBe(true);
    expect(spawnEvent?.stdinHasObjective).toBe(true);

    const debugEvents = readJsonLines(findRunLogPath(cwd)).map(
      (entry) => entry.event,
    );
    expect(debugEvents).toContain("agent:run:start");
    expect(debugEvents).toContain("agent:run:end");
    expect(debugEvents).toContain("run:complete");
  }, 30_000);

  it("keeps --force when agentArgsOverride.cursor sets --sandbox=enabled", async () => {
    chmodSync(mockCursorAgentPath, 0o755);
    const cwd = createRepo();
    tempDirs.push(cwd);
    const logDir = mkdtempSync(join(tmpdir(), "gnhf-e2e-cursor-logs-"));
    tempDirs.push(logDir);
    const mockLogPath = join(logDir, "mock-cursor-sandbox.jsonl");

    const result = await runCli(
      cwd,
      [
        "add a hello.txt via cursor agent",
        "--agent",
        "cursor",
        "--max-iterations",
        "1",
        "--current-branch",
        "--prevent-sleep",
        "off",
      ],
      {
        env: createCursorEnv(tempDirs, {
          mockLogPath,
          extraConfigYaml: [
            "agentArgsOverride:",
            "  cursor:",
            "    - --sandbox=enabled",
          ].join("\n"),
        }),
      },
    );

    expect(result.code).toBe(0);
    expect(readFileSync(join(cwd, "hello.txt"), "utf-8")).toBe(
      "hello from cursor mock\n",
    );

    const spawnEvent = readJsonLines(mockLogPath).find(
      (entry) => entry.event === "spawn",
    );
    expect(spawnEvent?.argv).toEqual([
      "--sandbox=enabled",
      "-p",
      "--output-format",
      "stream-json",
      "--force",
      "--trust",
      "--approve-mcps",
    ]);
  }, 30_000);
});
