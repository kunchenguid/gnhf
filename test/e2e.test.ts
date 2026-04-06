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
const fixtureBinDir = join(repoRoot, "test", "fixtures");

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function createRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "gnhf-e2e-"));
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

/**
 * Locate the gnhf.log file that the run wrote inside the repo. gnhf always
 * writes to `<cwd>/.gnhf/runs/<runId>/gnhf.log`, and each test creates a
 * fresh repo, so there's exactly one run dir.
 */
function findRunLogPath(cwd: string): string {
  const runsDir = join(cwd, ".gnhf", "runs");
  if (!existsSync(runsDir)) {
    throw new Error(`No run directory found under ${runsDir}`);
  }
  const runs = readdirSync(runsDir);
  if (runs.length === 0) {
    throw new Error(`No runs found in ${runsDir}`);
  }
  // Each test uses a fresh repo, so there should be exactly one run dir.
  // Assert that loudly rather than silently picking runs[0], which is
  // alphabetical (not mtime) order and would mask bugs if a future test
  // ever produced more than one run.
  if (runs.length > 1) {
    throw new Error(
      `Expected exactly one run in ${runsDir}, found ${runs.length}: ${runs.join(", ")}`,
    );
  }
  return join(runsDir, runs[0]!, "gnhf.log");
}

async function waitForLogEvent(
  filePath: string,
  event: string,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const match = readJsonLines(filePath).find(
      (entry) => entry.event === event,
    );
    if (match) return match;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }

  throw new Error(`Timed out waiting for log event ${event} in ${filePath}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runCli(
  cwd: string,
  args: string[],
  options: { stdin?: string; env?: NodeJS.ProcessEnv } = {},
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

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}

describe("gnhf e2e", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } catch {
        // Windows: child processes may still hold file locks briefly after exit
      }
    }
  });

  it("runs one iteration from an argv prompt and cleans up the mock opencode server", async () => {
    const cwd = createRepo();
    tempDirs.push(cwd);
    const logDir = mkdtempSync(join(tmpdir(), "gnhf-e2e-logs-"));
    tempDirs.push(logDir);
    const mockLogPath = join(logDir, "mock-opencode.jsonl");

    const result = await runCli(
      cwd,
      ["ship it", "--agent", "opencode", "--max-iterations", "1"],
      {
        env: {
          ...process.env,
          PATH: `${fixtureBinDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
          GNHF_MOCK_OPENCODE_LOG_PATH: mockLogPath,
        },
      },
    );

    expect(result.code).toBe(0);
    expect(git(["rev-list", "--count", "HEAD"], cwd)).toBe("2");
    expect(git(["log", "-1", "--format=%s"], cwd)).toContain("gnhf #1:");

    const startEvent = await waitForLogEvent(mockLogPath, "server:start");
    expect(startEvent.command).toBe("serve");
    expect(isProcessAlive(Number(startEvent.pid))).toBe(false);

    const debugLogPath = findRunLogPath(cwd);
    const debugEvents = readJsonLines(debugLogPath).map((entry) => entry.event);
    expect(debugEvents).toContain("run:start");
    expect(debugEvents).toContain("orchestrator:start");
    expect(debugEvents).toContain("iteration:start");
    expect(debugEvents).toContain("iteration:end");
    expect(debugEvents).toContain("agent:run:start");
    expect(debugEvents).toContain("agent:run:end");
    expect(debugEvents).toContain("opencode:spawn");
    expect(debugEvents).toContain("opencode:run:start");
    expect(debugEvents).toContain("opencode:run:end");
    expect(debugEvents).toContain("run:complete");
  }, 30_000);

  it("reads the objective from stdin", async () => {
    const cwd = createRepo();
    tempDirs.push(cwd);
    const logDir = mkdtempSync(join(tmpdir(), "gnhf-e2e-logs-"));
    tempDirs.push(logDir);
    const mockLogPath = join(logDir, "mock-opencode.jsonl");

    const result = await runCli(
      cwd,
      ["--agent", "opencode", "--max-iterations", "1"],
      {
        stdin: "ship it from stdin\n",
        env: {
          ...process.env,
          PATH: `${fixtureBinDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
          GNHF_MOCK_OPENCODE_LOG_PATH: mockLogPath,
        },
      },
    );

    expect(result.code).toBe(0);

    const messageEvent = await waitForLogEvent(mockLogPath, "message:start");
    expect(String(messageEvent.prompt)).toContain("ship it from stdin");
  }, 30_000);

  it("resumes an existing gnhf branch without requiring the prompt again", async () => {
    const cwd = createRepo();
    tempDirs.push(cwd);
    const logDir = mkdtempSync(join(tmpdir(), "gnhf-e2e-logs-"));
    tempDirs.push(logDir);
    const mockLogPath = join(logDir, "mock-opencode.jsonl");

    const env = {
      ...process.env,
      PATH: `${fixtureBinDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      GNHF_MOCK_OPENCODE_LOG_PATH: mockLogPath,
    };

    const firstRun = await runCli(
      cwd,
      ["first prompt", "--agent", "opencode", "--max-iterations", "1"],
      { env },
    );
    expect(firstRun.code).toBe(0);

    const secondRun = await runCli(
      cwd,
      ["--agent", "opencode", "--max-iterations", "2"],
      { env },
    );
    expect(secondRun.code).toBe(0);
    expect(git(["rev-list", "--count", "HEAD"], cwd)).toBe("3");
  }, 30_000);

  // Windows has no POSIX signals; child.kill("SIGINT") force-terminates the
  // process tree without triggering the graceful shutdown path this test covers.
  it.skipIf(process.platform === "win32")("shuts down the agent server when gnhf receives SIGINT", async () => {
    const cwd = createRepo();
    tempDirs.push(cwd);
    const logDir = mkdtempSync(join(tmpdir(), "gnhf-e2e-logs-"));
    tempDirs.push(logDir);
    const mockLogPath = join(logDir, "mock-opencode.jsonl");

    const child = spawn(
      process.execPath,
      [distCliPath, "slow cleanup", "--agent", "opencode"],
      {
        cwd,
        env: {
          ...process.env,
          PATH: `${fixtureBinDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
          GNHF_MOCK_OPENCODE_LOG_PATH: mockLogPath,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.stdin.end();

    const exitPromise = new Promise<RunResult>((resolveResult, reject) => {
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
    });

    const startEvent = await waitForLogEvent(mockLogPath, "server:start");
    await waitForLogEvent(mockLogPath, "message:start");
    child.kill("SIGINT");

    const result = await exitPromise;
    expect(result.code).toBe(130);
    expect(isProcessAlive(Number(startEvent.pid))).toBe(false);

    const mockEvents = readJsonLines(mockLogPath).map((entry) => entry.event);
    expect(mockEvents).toContain("session:abort");
    expect(mockEvents).toContain("session:delete");

    const debugLogPath = findRunLogPath(cwd);
    const debugEvents = readJsonLines(debugLogPath).map((entry) => entry.event);
    expect(debugEvents).toContain("signal:SIGINT");
    expect(debugEvents).toContain("orchestrator:stop-requested");
  }, 30_000);
});
