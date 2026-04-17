import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { commitAll, createBranch } from "./git.js";

function rawGit(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "gnhf-injection-"));
  rawGit(["init", "-b", "main"], cwd);
  rawGit(["config", "user.name", "gnhf tests"], cwd);
  rawGit(["config", "user.email", "tests@example.com"], cwd);
  writeFileSync(join(cwd, "seed.txt"), "seed\n", "utf-8");
  rawGit(["add", "seed.txt"], cwd);
  rawGit(["commit", "-m", "init"], cwd);
  return cwd;
}

describe("git shell injection regression", () => {
  const repos: string[] = [];
  const markerName = `gnhf-injection-marker-${process.pid}`;
  const marker = join(tmpdir(), markerName);

  afterEach(() => {
    for (const dir of repos.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    rmSync(marker, { force: true });
  });

  it("commitAll does not evaluate backticks in the commit message", () => {
    const repo = makeRepo();
    repos.push(repo);
    writeFileSync(join(repo, "work.txt"), "work\n", "utf-8");

    const injected = `feat: add work \`touch ${marker}\` done`;
    commitAll(injected, repo);

    expect(existsSync(marker)).toBe(false);

    const subject = rawGit(["log", "-1", "--pretty=%s"], repo);
    expect(subject).toBe(injected);
  });

  it("commitAll does not evaluate $(...) in the commit message", () => {
    const repo = makeRepo();
    repos.push(repo);
    writeFileSync(join(repo, "work.txt"), "work\n", "utf-8");

    const injected = `feat: add $(touch ${marker}) thing`;
    commitAll(injected, repo);

    expect(existsSync(marker)).toBe(false);
    const subject = rawGit(["log", "-1", "--pretty=%s"], repo);
    expect(subject).toBe(injected);
  });

  it("commitAll preserves embedded double quotes verbatim in the commit message", () => {
    const repo = makeRepo();
    repos.push(repo);
    writeFileSync(join(repo, "work.txt"), "work\n", "utf-8");

    const message = 'fix "broken" test';
    commitAll(message, repo);

    const subject = rawGit(["log", "-1", "--pretty=%s"], repo);
    expect(subject).toBe(message);
  });

  it("createBranch treats shell metacharacters in a valid branch name as inert text", () => {
    const repo = makeRepo();
    repos.push(repo);
    const repoMarker = join(repo, markerName);
    const injected = `evil\`touch\${IFS}${markerName}\``;

    createBranch(injected, repo);

    expect(existsSync(marker)).toBe(false);
    expect(existsSync(repoMarker)).toBe(false);
    expect(rawGit(["branch", "--show-current"], repo)).toBe(injected);
  });
});
