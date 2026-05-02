import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distCliPath = join(repoRoot, "dist", "cli.mjs");
const packageVersion = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf-8"),
).version as string;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [distCliPath, ...args], {
      cwd,
      env: env ?? process.env,
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
    child.on("close", (code) => {
      resolveResult({ code, stdout, stderr });
    });
    child.stdin.end();
  });
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `gnhf-e2e-cli-${prefix}-`));
  onTestFinished(() => {
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
  });
  return dir;
}

function createRepo(): string {
  const cwd = createTempDir("repo");
  git(["init", "-b", "main"], cwd);
  git(["config", "user.name", "gnhf tests"], cwd);
  git(["config", "user.email", "tests@example.com"], cwd);
  writeFileSync(join(cwd, "README.md"), "# fixture\n", "utf-8");
  git(["add", "README.md"], cwd);
  git(["commit", "-m", "init"], cwd);
  return cwd;
}

describe.concurrent("gnhf e2e cli", () => {
  it("prints the package version for -V", async () => {
    const cwd = createTempDir("version");

    const result = await runCli(cwd, ["-V"]);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(packageVersion);
  }, 15_000);

  it("prints a friendly message outside a git repository", async () => {
    const cwd = createTempDir("no-git");

    const result = await runCli(cwd, ["ship it", "--agent", "claude"]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      'gnhf: This command must be run inside a Git repository. Change into a repo or run "git init" first.',
    );
  }, 15_000);

  it("exits with error when --worktree is used from a gnhf branch", async () => {
    const cwd = createRepo();
    git(["checkout", "-b", "gnhf/existing-run"], cwd);

    const result = await runCli(cwd, [
      "new objective",
      "--agent",
      "claude",
      "--worktree",
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Cannot use --worktree from a gnhf branch");
  }, 15_000);
});
