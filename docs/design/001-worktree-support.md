# Git Worktree Support for gnhf - Implementation Report

## Overview

This report summarizes the implementation of git worktree support for gnhf, enabling multiple agents to work on the same repository concurrently by creating isolated working directories via `git worktree`.

## Problem

Previously, gnhf could only run one agent at a time per repository because it creates a branch (`gnhf/<slug>`) and works directly in the repository's working tree. Running a second agent would conflict with the first agent's branch and file changes.

## Solution

Added a `--worktree` flag that creates a separate git worktree for each agent run, giving each agent its own isolated working directory and branch. This allows multiple agents to work on the same repository simultaneously without interference.

## Implementation Details

### Phase 1: Core Worktree Infrastructure

**Files changed:** `src/core/git.ts`, `src/cli.ts`, `src/core/git.test.ts`

**New git utilities (`src/core/git.ts`):**

| Function | Purpose |
|----------|---------|
| `getRepoRootDir(cwd)` | Returns the repository root directory (needed to compute worktree paths) |
| `createWorktree(baseCwd, path, branch)` | Creates a new git worktree with a new branch |
| `removeWorktree(baseCwd, path)` | Force-removes a git worktree |
| `listWorktrees(cwd)` | Lists all worktrees with parsed metadata (path, branch, head, bare) |

**CLI flow with `--worktree` (`src/cli.ts`):**

1. Validates the user is NOT on a gnhf branch (worktree mode is incompatible with nested gnhf branches)
2. Resolves the repo root directory
3. Creates a worktree at `<repo-parent>/<repo-name>-gnhf-worktrees/<runId>` with a new branch
4. Passes the worktree path as `effectiveCwd` to the orchestrator (all agent work happens there)
5. On exit:
   - If commits were made: preserves the worktree and prints merge instructions to stderr
   - If no commits: auto-removes the worktree (cleanup)

**Unit tests (`src/core/git.test.ts`):**
- 5 test cases covering `getRepoRootDir`, `createWorktree`, `removeWorktree`, and `listWorktrees` (normal output, empty output, bare repos)

### Phase 2: CLI Integration Tests

**Files changed:** `src/cli.test.ts`

| Test Case | What It Validates |
|-----------|-------------------|
| effectiveCwd wiring | Worktree is created at the correct path, `effectiveCwd` is passed to orchestrator |
| gnhf-branch rejection | Error message and `exit(1)` when `--worktree` is used from a gnhf branch |
| Cleanup on no commits | `removeWorktree` is called when orchestrator reports 0 commits |
| Preservation on commits | `removeWorktree` is NOT called when orchestrator reports commits > 0 |

### Phase 3: Documentation

**Files changed:** `README.md`, `REPORT.md`

- Added `--worktree` flag to README.md flags table
- Added worktree usage example to Quick Start section
- Added "Worktree Mode" section explaining architecture and behavior
- Created this implementation report

### Phase 4: End-to-End Testing

**Files changed:** `test/e2e.test.ts`

| Test Case | What It Validates |
|-----------|-------------------|
| Worktree with commits preserved | Full happy path: creates real git repo, runs `gnhf --worktree`, verifies worktree directory exists, branch is `gnhf/*`, agent commit is present, original repo is untouched on `main`, debug log records `worktree: true`, stderr shows preservation message |
| Worktree cleanup on no commits | Sends SIGINT during a "slow cleanup" prompt (mock agent doesn't respond), verifies worktree directory is cleaned up after zero commits, original repo stays on `main` |

These tests exercise the actual git worktree lifecycle against real temporary repositories (using the mock opencode agent), complementing the mock-based unit and CLI integration tests from phases 1–2.

## Architecture Notes

- The existing architecture's separation of `cwd` from run metadata paths made worktree integration straightforward — the orchestrator accepts a `cwd` parameter and all agent work happens there
- Worktree paths are placed outside the repo (at a sibling directory) to avoid nesting issues
- The `.gnhf/runs/` directory is excluded via `.git/info/exclude`, which is shared across worktrees, so run metadata is properly gitignored everywhere
- `git worktree list --porcelain` output uses blank lines as record separators; the parser handles the edge case where the last entry may lack a trailing blank line
- Worktree mode is incompatible with running from an existing gnhf branch (would create nested gnhf branches), so it requires being on a non-gnhf branch — enforced with a clear error message

## Test Results

All tests pass:
- **334 total tests** across 29 test files
- Typecheck: clean
- Lint: clean

## Changes Summary

| File | Lines Added | Lines Removed | Description |
|------|-------------|---------------|-------------|
| `src/core/git.ts` | +65 | 0 | 4 new git utility functions + `WorktreeInfo` interface |
| `src/core/git.test.ts` | +110 | 0 | Unit tests for all new git functions |
| `src/cli.ts` | +81 | ~1 | `--worktree` flag, `initializeWorktreeRun()`, cleanup logic |
| `src/cli.test.ts` | +227 | ~17 | 4 CLI integration tests + mock infrastructure extensions |
| `README.md` | ~25 | 0 | Worktree documentation in Quick Start, Flags, and new section |
| `test/e2e.test.ts` | +95 | 0 | 2 end-to-end tests exercising real git worktree operations |
| `REPORT.md` | ~105 | 0 | This implementation report |

## Usage

```bash
# Run a single agent in a worktree
gnhf --worktree "implement feature X"

# Run multiple agents on the same repo simultaneously
gnhf --worktree "implement feature X" &
gnhf --worktree "add tests for module Y" &
gnhf --worktree "refactor the API layer" &
```

Each agent gets its own isolated branch and working directory, so they won't interfere with each other. Worktrees with commits are preserved after the run; empty worktrees are cleaned up automatically.

## Conclusion

The `--worktree` feature is fully implemented, tested, and documented. It solves the original problem of running multiple agents on the same repo concurrently by leveraging git's native worktree mechanism. The implementation required minimal changes to the existing architecture (primarily injecting a different `effectiveCwd` into the orchestrator) and follows the same patterns used elsewhere in the codebase. All 334 tests pass across 29 test files with clean typecheck and lint.
