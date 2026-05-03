import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import {
  ensureCleanWorkingTree,
  createBranch,
  commitAll,
  findLegacyRunBaseCommit,
  getBranchCommitCount,
  getBranchDiffStats,
  getCurrentBranch,
  resetHard,
  getRepoRootDir,
  createWorktree,
  removeWorktree,
  worktreeExists,
} from "./git.js";

const mockExecFileSync = vi.mocked(execFileSync);

function argsOfCall(index: number): string[] {
  const call = mockExecFileSync.mock.calls[index];
  if (!call) throw new Error(`no call at index ${index}`);
  return call[1] as string[];
}

function optionsOfCall(index: number): {
  cwd?: string;
  env?: Record<string, string | undefined>;
} {
  const call = mockExecFileSync.mock.calls[index];
  if (!call) throw new Error(`no call at index ${index}`);
  return (call[2] ?? {}) as {
    cwd?: string;
    env?: Record<string, string | undefined>;
  };
}

describe("git utilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockReturnValue("");
  });

  describe("ensureCleanWorkingTree", () => {
    it("does not throw when working tree is clean", () => {
      mockExecFileSync.mockReturnValue("");
      expect(() => ensureCleanWorkingTree("/repo")).not.toThrow();
    });

    it("throws when working tree has changes", () => {
      mockExecFileSync.mockReturnValue(" M src/index.ts");
      expect(() => ensureCleanWorkingTree("/repo")).toThrow(
        "Working tree is not clean",
      );
    });

    it("invokes git status --porcelain with argv and the expected cwd", () => {
      mockExecFileSync.mockReturnValue("");
      ensureCleanWorkingTree("/my/repo");
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "git",
        ["status", "--porcelain"],
        expect.objectContaining({
          cwd: "/my/repo",
          encoding: "utf-8",
          stdio: "pipe",
        }),
      );
    });
  });

  describe("createBranch", () => {
    it("passes the branch name as its own argv entry so shell metacharacters are inert", () => {
      createBranch("feature/test", "/repo");
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "git",
        ["checkout", "-b", "feature/test"],
        expect.objectContaining({
          cwd: "/repo",
          encoding: "utf-8",
          stdio: "pipe",
        }),
      );
    });
  });

  describe("getCurrentBranch", () => {
    it("returns the current branch name when HEAD points to a branch", () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        const argv = args as string[];
        if (argv[0] === "rev-parse" && argv[1] === "--git-dir") {
          return ".git\n";
        }
        if (argv[0] === "symbolic-ref") {
          return "feature/test\n";
        }
        return "";
      });

      expect(getCurrentBranch("/repo")).toBe("feature/test");
      expect(argsOfCall(0)).toEqual(["rev-parse", "--git-dir"]);
      expect(argsOfCall(1)).toEqual(["symbolic-ref", "--short", "HEAD"]);
    });

    it("falls back to rev-parse when symbolic-ref fails, such as in detached HEAD", () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        const argv = args as string[];
        if (argv[0] === "rev-parse" && argv[1] === "--git-dir") {
          return ".git\n";
        }
        if (argv[0] === "symbolic-ref") {
          throw new Error("detached HEAD");
        }
        if (
          argv[0] === "rev-parse" &&
          argv[1] === "--abbrev-ref" &&
          argv[2] === "HEAD"
        ) {
          return "HEAD\n";
        }
        return "";
      });

      expect(getCurrentBranch("/repo")).toBe("HEAD");
      expect(argsOfCall(2)).toEqual(["rev-parse", "--abbrev-ref", "HEAD"]);
    });

    it("rewrites non-repository git errors with a friendly message", () => {
      const error = Object.assign(new Error("Command failed"), {
        stderr:
          "fatal: not a git repository (or any of the parent directories): .git",
      });
      mockExecFileSync.mockImplementation(() => {
        throw error;
      });

      expect(() => getCurrentBranch("/repo")).toThrow(
        'This command must be run inside a Git repository. Change into a repo or run "git init" first.',
      );
    });
  });

  describe("commitAll", () => {
    it("stages all files and passes the message as its own argv entry", () => {
      commitAll("initial commit", "/repo");
      expect(argsOfCall(0)).toEqual(["add", "-A"]);
      expect(argsOfCall(1)).toEqual([
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        "commit",
        "-m",
        "initial commit",
      ]);
    });

    it("disables GPG signing on the commit so a configured signing key cannot prompt", () => {
      commitAll("anything", "/repo");
      const args = argsOfCall(1);
      expect(args).toContain("commit.gpgsign=false");
      expect(args).toContain("tag.gpgsign=false");
      expect(args.indexOf("commit.gpgsign=false")).toBeLessThan(
        args.indexOf("commit"),
      );
    });

    it("preserves shell metacharacters in the message without any escaping", () => {
      const injection = "feat: `touch /tmp/pwn` && $(evil) \"quoted\" 'tick'";
      commitAll(injection, "/repo");
      expect(argsOfCall(1)).toContain(injection);
    });

    it("does not throw when there is nothing to commit", () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        const argv = args as string[];
        if (argv.includes("commit")) {
          throw new Error("nothing to commit");
        }
        return "";
      });

      expect(() => commitAll("empty", "/repo")).not.toThrow();
    });
  });

  describe("prompt-blocking env vars", () => {
    it("sets GIT_TERMINAL_PROMPT=0 on every git invocation so HTTPS auth prompts cannot block", () => {
      ensureCleanWorkingTree("/repo");
      expect(optionsOfCall(0).env?.GIT_TERMINAL_PROMPT).toBe("0");
    });

    it("preserves existing process.env keys alongside GIT_TERMINAL_PROMPT", () => {
      ensureCleanWorkingTree("/repo");
      const env = optionsOfCall(0).env ?? {};
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    });

    it("keeps GIT_TERMINAL_PROMPT=0 when the caller passes its own env (e.g. LC_ALL)", () => {
      // getCurrentBranch -> isGitRepository sets LC_ALL=C internally; the
      // helper must still inject GIT_TERMINAL_PROMPT into that custom env.
      getCurrentBranch("/repo");
      // First call is the rev-parse --git-dir probe with LC_ALL=C.
      const probe = optionsOfCall(0);
      expect(probe.env?.LC_ALL).toBe("C");
      expect(probe.env?.GIT_TERMINAL_PROMPT).toBe("0");
    });
  });

  describe("getBranchCommitCount", () => {
    it("counts commits on the current gnhf branch from the base commit", () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        const argv = args as string[];
        if (argv[0] === "rev-list" && argv.includes("abc123..HEAD")) {
          return "1";
        }
        return "";
      });

      expect(getBranchCommitCount("abc123", "/repo")).toBe(1);
    });

    it("returns 0 when the branch has no commits after the base commit", () => {
      mockExecFileSync.mockReturnValue("0");
      expect(getBranchCommitCount("abc123", "/repo")).toBe(0);
    });

    it("returns 0 when the base commit is missing", () => {
      expect(getBranchCommitCount("", "/repo")).toBe(0);
    });
  });

  describe("getBranchDiffStats", () => {
    it("summarizes commits, file status, and line counts from the branch base", () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        const argv = args as string[];
        if (argv[0] === "rev-list") return "6";
        if (argv[0] === "diff" && argv[1] === "--name-status") {
          return [
            "A\tsrc/new.ts",
            "M\tsrc/changed.ts",
            "D\tsrc/old.ts",
            "R100\tsrc/before.ts\tsrc/after.ts",
          ].join("\n");
        }
        if (argv[0] === "diff" && argv[1] === "--numstat") {
          return [
            "10\t0\tsrc/new.ts",
            "4\t2\tsrc/changed.ts",
            "0\t8\tsrc/old.ts",
            "-\t-\tassets/logo.png",
          ].join("\n");
        }
        return "";
      });

      expect(getBranchDiffStats("abc123", "/repo")).toEqual({
        commits: 6,
        filesChanged: 4,
        filesAdded: 1,
        filesUpdated: 2,
        filesDeleted: 1,
        filesRenamed: 1,
        binaryFiles: 1,
        linesAdded: 14,
        linesDeleted: 10,
      });
      expect(argsOfCall(0)).toEqual([
        "rev-list",
        "--count",
        "--first-parent",
        "abc123..HEAD",
      ]);
      expect(argsOfCall(1)).toEqual(["diff", "--name-status", "abc123..HEAD"]);
      expect(argsOfCall(2)).toEqual(["diff", "--numstat", "abc123..HEAD"]);
    });

    it("returns empty stats when there is no base commit", () => {
      expect(getBranchDiffStats("", "/repo")).toEqual({
        commits: 0,
        filesChanged: 0,
        filesAdded: 0,
        filesUpdated: 0,
        filesDeleted: 0,
        filesRenamed: 0,
        binaryFiles: 0,
        linesAdded: 0,
        linesDeleted: 0,
      });
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });
  });

  describe("findLegacyRunBaseCommit", () => {
    it("derives the branch base from the initialize marker parent", () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        const argv = args as string[];
        if (argv[0] === "log") {
          return [
            "abc123\tinitial repo commit",
            "def456\tgnhf: initialize run run-abc",
            "ghi789\tgnhf #1: add tests",
          ].join("\n");
        }
        if (argv[0] === "rev-parse" && argv[1] === "def456^") {
          return "abc123";
        }
        return "";
      });

      expect(findLegacyRunBaseCommit("run-abc", "/repo")).toBe("abc123");
    });

    it("returns null when no legacy marker exists", () => {
      mockExecFileSync.mockReturnValue("abc123\tinitial repo commit");
      expect(findLegacyRunBaseCommit("run-abc", "/repo")).toBeNull();
    });
  });

  describe("resetHard", () => {
    it("runs git reset --hard HEAD and git clean -fd", () => {
      resetHard("/repo");
      expect(argsOfCall(0)).toEqual(["reset", "--hard", "HEAD"]);
      expect(argsOfCall(1)).toEqual(["clean", "-fd"]);
    });
  });

  describe("getRepoRootDir", () => {
    it("returns the repo root directory", () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        const argv = args as string[];
        if (argv[1] === "--git-dir") return ".git\n";
        if (argv[1] === "--show-toplevel") return "/my/repo\n";
        return "";
      });
      expect(getRepoRootDir("/my/repo/sub")).toBe("/my/repo");
    });
  });

  describe("createWorktree", () => {
    it("passes the branch name and path as distinct argv entries", () => {
      createWorktree("/repo", "/tmp/wt", "gnhf/my-branch");
      expect(argsOfCall(0)).toEqual([
        "worktree",
        "add",
        "-b",
        "gnhf/my-branch",
        "/tmp/wt",
      ]);
    });
  });

  describe("removeWorktree", () => {
    it("passes the worktree path as its own argv entry", () => {
      removeWorktree("/repo", "/tmp/wt");
      expect(argsOfCall(0)).toEqual([
        "worktree",
        "remove",
        "--force",
        "/tmp/wt",
      ]);
    });
  });

  describe("worktreeExists", () => {
    it("returns true when the path is registered as a worktree", () => {
      mockExecFileSync.mockReturnValue(
        [
          "worktree /tmp/repo",
          "HEAD abc123",
          "branch refs/heads/main",
          "",
          "worktree /tmp/repo-gnhf-worktrees/xyz",
          "HEAD def456",
          "branch refs/heads/gnhf/xyz",
          "",
        ].join("\n"),
      );
      expect(worktreeExists("/tmp/repo", "/tmp/repo-gnhf-worktrees/xyz")).toBe(
        true,
      );
    });

    it("returns false when the path is not registered", () => {
      mockExecFileSync.mockReturnValue(
        [
          "worktree /tmp/repo",
          "HEAD abc123",
          "branch refs/heads/main",
          "",
        ].join("\n"),
      );
      expect(worktreeExists("/tmp/repo", "/tmp/repo-gnhf-worktrees/xyz")).toBe(
        false,
      );
    });

    it("normalizes paths before comparing so trailing slashes and traversal segments still match", () => {
      mockExecFileSync.mockReturnValue(
        [
          "worktree /tmp/repo-gnhf-worktrees/xyz",
          "HEAD def456",
          "branch refs/heads/gnhf/xyz",
          "",
        ].join("\n"),
      );
      expect(
        worktreeExists("/tmp/repo", "/tmp/repo-gnhf-worktrees/other/../xyz/"),
      ).toBe(true);
    });

    it("returns false when git worktree list fails", () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("not a git repo");
      });
      expect(worktreeExists("/tmp/repo", "/tmp/wt")).toBe(false);
    });
  });
});
