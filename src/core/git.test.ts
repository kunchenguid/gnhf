import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import {
  ensureCleanWorkingTree,
  createBranch,
  commitAll,
  findLegacyRunBaseCommit,
  getBranchCommitCount,
  getCurrentBranch,
  resetHard,
} from "./git.js";

const mockExecSync = vi.mocked(execSync);

describe("git utilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSync.mockReturnValue("");
  });

  describe("ensureCleanWorkingTree", () => {
    it("does not throw when working tree is clean", () => {
      mockExecSync.mockReturnValue("");
      expect(() => ensureCleanWorkingTree("/repo")).not.toThrow();
    });

    it("throws when working tree has changes", () => {
      mockExecSync.mockReturnValue(" M src/index.ts");
      expect(() => ensureCleanWorkingTree("/repo")).toThrow(
        "Working tree is not clean",
      );
    });

    it("calls git status --porcelain with correct cwd", () => {
      mockExecSync.mockReturnValue("");
      ensureCleanWorkingTree("/my/repo");
      expect(mockExecSync).toHaveBeenCalledWith("git status --porcelain", {
        cwd: "/my/repo",
        encoding: "utf-8",
        stdio: "pipe",
      });
    });
  });

  describe("createBranch", () => {
    it("calls git checkout -b with the branch name", () => {
      createBranch("feature/test", "/repo");
      expect(mockExecSync).toHaveBeenCalledWith(
        "git checkout -b feature/test",
        {
          cwd: "/repo",
          encoding: "utf-8",
          stdio: "pipe",
        },
      );
    });
  });

  describe("getCurrentBranch", () => {
    it("returns the current branch name when HEAD points to a branch", () => {
      mockExecSync.mockImplementation((cmd) => {
        if (cmd === "git rev-parse --git-dir") {
          return ".git\n";
        }
        if (cmd === "git symbolic-ref --short HEAD") {
          return "feature/test\n";
        }
        return "";
      });

      expect(getCurrentBranch("/repo")).toBe("feature/test");
      expect(mockExecSync).toHaveBeenNthCalledWith(
        1,
        "git rev-parse --git-dir",
        {
          cwd: "/repo",
          encoding: "utf-8",
          stdio: "pipe",
          env: expect.objectContaining({ LC_ALL: "C" }),
        },
      );
      expect(mockExecSync).toHaveBeenNthCalledWith(
        2,
        "git symbolic-ref --short HEAD",
        {
          cwd: "/repo",
          encoding: "utf-8",
          stdio: "pipe",
        },
      );
    });

    it("falls back to rev-parse when symbolic-ref fails, such as in detached HEAD", () => {
      mockExecSync.mockImplementation((cmd) => {
        if (cmd === "git rev-parse --git-dir") {
          return ".git\n";
        }
        if (cmd === "git symbolic-ref --short HEAD") {
          throw new Error("detached HEAD");
        }
        if (cmd === "git rev-parse --abbrev-ref HEAD") {
          return "HEAD\n";
        }
        return "";
      });

      expect(getCurrentBranch("/repo")).toBe("HEAD");
      expect(mockExecSync).toHaveBeenCalledWith(
        "git rev-parse --abbrev-ref HEAD",
        {
          cwd: "/repo",
          encoding: "utf-8",
          stdio: "pipe",
        },
      );
    });

    it("rewrites non-repository git errors with a friendly message", () => {
      const error = Object.assign(new Error("Command failed"), {
        stderr:
          "fatal: not a git repository (or any of the parent directories): .git",
      });
      mockExecSync.mockImplementation(() => {
        throw error;
      });

      expect(() => getCurrentBranch("/repo")).toThrow(
        'This command must be run inside a Git repository. Change into a repo or run "git init" first.',
      );
    });
  });

  describe("commitAll", () => {
    it("stages all files and commits with the message", () => {
      commitAll("initial commit", "/repo");
      expect(mockExecSync).toHaveBeenCalledWith("git add -A", {
        cwd: "/repo",
        encoding: "utf-8",
        stdio: "pipe",
      });
      expect(mockExecSync).toHaveBeenCalledWith(
        'git commit -m "initial commit"',
        {
          cwd: "/repo",
          encoding: "utf-8",
          stdio: "pipe",
        },
      );
    });

    it("escapes double quotes in commit message", () => {
      commitAll('fix "broken" test', "/repo");
      expect(mockExecSync).toHaveBeenCalledWith(
        'git commit -m "fix \\"broken\\" test"',
        {
          cwd: "/repo",
          encoding: "utf-8",
          stdio: "pipe",
        },
      );
    });

    it("does not throw when there is nothing to commit", () => {
      mockExecSync.mockImplementation((cmd) => {
        if (typeof cmd === "string" && cmd.startsWith("git commit")) {
          throw new Error("nothing to commit");
        }
        return "";
      });

      expect(() => commitAll("empty", "/repo")).not.toThrow();
    });
  });

  describe("getBranchCommitCount", () => {
    it("counts commits on the current gnhf branch from the base commit", () => {
      mockExecSync.mockImplementation((cmd) => {
        if (cmd === "git rev-list --count --first-parent abc123..HEAD") {
          return "1";
        }
        return "";
      });

      expect(getBranchCommitCount("abc123", "/repo")).toBe(1);
    });

    it("counts all branch commits after the base commit", () => {
      mockExecSync.mockImplementation((cmd) => {
        if (cmd === "git rev-list --count --first-parent base123..HEAD") {
          return "4";
        }
        return "";
      });

      expect(getBranchCommitCount("base123", "/repo")).toBe(4);
    });

    it("returns 0 when the branch has no commits after the base commit", () => {
      mockExecSync.mockImplementation((cmd) => {
        if (cmd === "git rev-list --count --first-parent abc123..HEAD") {
          return "0";
        }
        return "";
      });

      expect(getBranchCommitCount("abc123", "/repo")).toBe(0);
    });

    it("returns 0 when the base commit is missing", () => {
      expect(getBranchCommitCount("", "/repo")).toBe(0);
    });
  });

  describe("findLegacyRunBaseCommit", () => {
    it("derives the branch base from the initialize marker parent", () => {
      mockExecSync.mockImplementation((cmd) => {
        if (cmd === "git log --first-parent --reverse --format=%H%x09%s HEAD") {
          return [
            "abc123\tinitial repo commit",
            "def456\tgnhf: initialize run run-abc",
            "ghi789\tgnhf #1: add tests",
          ].join("\n");
        }
        if (cmd === "git rev-parse def456^") {
          return "abc123";
        }
        return "";
      });

      expect(findLegacyRunBaseCommit("run-abc", "/repo")).toBe("abc123");
    });

    it("returns null when no legacy marker exists", () => {
      mockExecSync.mockReturnValue("abc123\tinitial repo commit");
      expect(findLegacyRunBaseCommit("run-abc", "/repo")).toBeNull();
    });
  });

  describe("resetHard", () => {
    it("runs git reset --hard HEAD and git clean -fd", () => {
      resetHard("/repo");
      expect(mockExecSync).toHaveBeenCalledWith("git reset --hard HEAD", {
        cwd: "/repo",
        encoding: "utf-8",
        stdio: "pipe",
      });
      expect(mockExecSync).toHaveBeenCalledWith("git clean -fd", {
        cwd: "/repo",
        encoding: "utf-8",
        stdio: "pipe",
      });
    });
  });
});
