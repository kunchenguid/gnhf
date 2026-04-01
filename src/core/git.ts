import { execSync } from "node:child_process";

const NOT_GIT_REPOSITORY_MESSAGE =
  'This command must be run inside a Git repository. Change into a repo or run "git init" first.';

function translateGitError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function git(args: string, cwd: string): string {
  try {
    return execSync(`git ${args}`, {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch (error) {
    throw translateGitError(error);
  }
}

function isGitRepository(cwd: string): boolean {
  try {
    execSync("git rev-parse --git-dir", {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
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
    return git("symbolic-ref --short HEAD", cwd);
  } catch {
    return git("rev-parse --abbrev-ref HEAD", cwd);
  }
}

export function ensureCleanWorkingTree(cwd: string): void {
  const status = git("status --porcelain", cwd);
  if (status) {
    throw new Error(
      "Working tree is not clean. Commit or stash changes first.",
    );
  }
}

export function createBranch(branchName: string, cwd: string): void {
  git(`checkout -b ${branchName}`, cwd);
}

export function getHeadCommit(cwd: string): string {
  return git("rev-parse HEAD", cwd);
}

export function findLegacyRunBaseCommit(
  runId: string,
  cwd: string,
): string | null {
  try {
    const history = git(
      "log --first-parent --reverse --format=%H%x09%s HEAD",
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
    return git(`rev-parse ${marker.sha}^`, cwd);
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
    git(`rev-list --count --first-parent ${baseCommit}..HEAD`, cwd),
    10,
  );
}

export function commitAll(message: string, cwd: string): void {
  git("add -A", cwd);
  try {
    git(`commit -m "${message.replace(/"/g, '\\"')}"`, cwd);
  } catch {
    // Nothing to commit (no changes) -- that's fine
  }
}

export function resetHard(cwd: string): void {
  git("reset --hard HEAD", cwd);
  git("clean -fd", cwd);
}
