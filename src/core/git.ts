import { execFileSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";

const NOT_GIT_REPOSITORY_MESSAGE =
  'This command must be run inside a Git repository. Change into a repo or run "git init" first.';

function translateGitError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

// All git invocations go through this helper, which uses execFileSync with an
// argv array (no shell). That means caller-supplied strings such as commit
// messages, branch names, and paths are never interpreted by a shell, so
// characters like `, $, ", ', and ; are harmless data rather than executable
// syntax. Do not add a code path that builds a shell command string from
// user- or agent-provided input.
//
// Always inject GIT_TERMINAL_PROMPT=0 so a misconfigured credential helper
// or an HTTPS auth challenge can't hang a long-running gnhf loop on a
// terminal prompt. GPG signing is a separate prompt pathway (pinentry) and
// is disabled where it matters via `-c commit.gpgsign=false` at the call
// site (see commitAll), since GIT_TERMINAL_PROMPT does not cover it.
function git(
  args: string[],
  cwd: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): string {
  const baseEnv = options.env ?? process.env;
  const env: NodeJS.ProcessEnv = { ...baseEnv, GIT_TERMINAL_PROMPT: "0" };
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
      env,
    }).trim();
  } catch (error) {
    throw translateGitError(error);
  }
}

function isGitRepository(cwd: string): boolean {
  try {
    git(["rev-parse", "--git-dir"], cwd, {
      env: { ...process.env, LC_ALL: "C" },
    });
    return true;
  } catch {
    return false;
  }
}

function ensureGitRepository(cwd: string): void {
  if (!isGitRepository(cwd)) {
    throw new Error(NOT_GIT_REPOSITORY_MESSAGE);
  }
}

export function getCurrentBranch(cwd: string): string {
  ensureGitRepository(cwd);
  try {
    return git(["symbolic-ref", "--short", "HEAD"], cwd);
  } catch {
    return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  }
}

export function ensureCleanWorkingTree(cwd: string): void {
  const status = git(["status", "--porcelain"], cwd);
  if (status) {
    throw new Error(
      "Working tree is not clean. Commit or stash changes first.",
    );
  }
}

export function createBranch(branchName: string, cwd: string): void {
  git(["checkout", "-b", branchName], cwd);
}

export function getHeadCommit(cwd: string): string {
  return git(["rev-parse", "HEAD"], cwd);
}

export function findLegacyRunBaseCommit(
  runId: string,
  cwd: string,
): string | null {
  try {
    const history = git(
      ["log", "--first-parent", "--reverse", "--format=%H%x09%s", "HEAD"],
      cwd,
    );
    const marker = history
      .split("\n")
      .map((line) => {
        const [sha, ...subjectParts] = line.split("\t");
        return { sha, subject: subjectParts.join("\t") };
      })
      .find(
        ({ subject }) =>
          subject === `gnhf: initialize run ${runId}` ||
          subject === `gnhf: overwrite run ${runId}`,
      );

    if (!marker?.sha) return null;
    return git(["rev-parse", `${marker.sha}^`], cwd);
  } catch {
    return null;
  }
}

export function getBranchCommitCount(baseCommit: string, cwd: string): number {
  if (!baseCommit) return 0;

  // Intentionally count from the branch base commit instead of gnhf marker
  // commits so the number reflects "work unique to this branch" and does not
  // depend on ignored run metadata producing a commit.
  return Number.parseInt(
    git(["rev-list", "--count", "--first-parent", `${baseCommit}..HEAD`], cwd),
    10,
  );
}

export interface BranchDiffStats {
  commits: number;
  filesChanged: number;
  filesAdded: number;
  filesUpdated: number;
  filesDeleted: number;
  filesRenamed: number;
  binaryFiles: number;
  linesAdded: number;
  linesDeleted: number;
}

function emptyBranchDiffStats(): BranchDiffStats {
  return {
    commits: 0,
    filesChanged: 0,
    filesAdded: 0,
    filesUpdated: 0,
    filesDeleted: 0,
    filesRenamed: 0,
    binaryFiles: 0,
    linesAdded: 0,
    linesDeleted: 0,
  };
}

export function getBranchDiffStats(
  baseCommit: string,
  cwd: string,
): BranchDiffStats {
  if (!baseCommit) return emptyBranchDiffStats();

  const range = `${baseCommit}..HEAD`;
  const stats = emptyBranchDiffStats();
  stats.commits = Number.parseInt(
    git(["rev-list", "--count", "--first-parent", range], cwd),
    10,
  );

  const nameStatus = git(["diff", "--name-status", range], cwd);
  for (const line of nameStatus.split("\n")) {
    if (!line) continue;
    const [status] = line.split("\t");
    stats.filesChanged++;
    if (status === "A") {
      stats.filesAdded++;
    } else if (status === "D") {
      stats.filesDeleted++;
    } else if (status?.startsWith("R")) {
      stats.filesUpdated++;
      stats.filesRenamed++;
    } else {
      stats.filesUpdated++;
    }
  }

  const numstat = git(["diff", "--numstat", range], cwd);
  for (const line of numstat.split("\n")) {
    if (!line) continue;
    const [added, deleted] = line.split("\t");
    if (added === "-" || deleted === "-") {
      stats.binaryFiles++;
      continue;
    }
    stats.linesAdded += Number.parseInt(added ?? "0", 10) || 0;
    stats.linesDeleted += Number.parseInt(deleted ?? "0", 10) || 0;
  }

  return stats;
}

export function commitAll(message: string, cwd: string): void {
  git(["add", "-A"], cwd);
  try {
    // -c commit.gpgsign=false / tag.gpgsign=false: a user with global
    // signing enabled would otherwise have every gnhf iteration spawn gpg
    // and (for a locked agent) wait on a pinentry passphrase prompt that
    // never arrives in the alt-screen TUI.
    git(
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        "commit",
        "-m",
        message,
      ],
      cwd,
    );
  } catch {
    // Nothing to commit (no changes) -- that's fine
  }
}

export function resetHard(cwd: string): void {
  git(["reset", "--hard", "HEAD"], cwd);
  git(["clean", "-fd"], cwd);
}

export function getRepoRootDir(cwd: string): string {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

export function createWorktree(
  baseCwd: string,
  worktreePath: string,
  branchName: string,
): void {
  git(["worktree", "add", "-b", branchName, worktreePath], baseCwd);
}

export function removeWorktree(baseCwd: string, worktreePath: string): void {
  git(["worktree", "remove", "--force", worktreePath], baseCwd);
}

export function listWorktreePaths(baseCwd: string): Set<string> {
  let output: string;
  try {
    output = git(["worktree", "list", "--porcelain"], baseCwd);
  } catch {
    return new Set();
  }
  const paths = new Set<string>();
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      paths.add(resolvePath(line.slice(9)));
    }
  }
  return paths;
}

// Returns true when the given path is registered as a worktree of baseCwd's
// repository. Used to decide whether to reuse a preserved worktree on a
// subsequent invocation instead of failing on "branch already exists".
//
// Compares resolved absolute paths because `git worktree list --porcelain`
// can emit forward-slash paths on Windows while `path.join` uses platform
// separators; plain string equality would then miss a real match.
export function worktreeExists(baseCwd: string, worktreePath: string): boolean {
  return listWorktreePaths(baseCwd).has(resolvePath(worktreePath));
}
