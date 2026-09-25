# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Project

`gnhf` ("good night, have fun") is a CLI that runs a coding agent in a loop inside a git repo, committing each successful iteration.
User-facing behavior (run modes, failure/rollback, usage-limit waits, worktrees, sleep prevention, agents) is owned by the [README](./README.md); test feature or scope decisions against [VISION.md](./VISION.md).
Target: Node 20+, published to npm as a bundled ESM CLI (`dist/cli.mjs`) with optional agent-facing skills under `skills/`.

## Commands

`package.json` scripts are the source of truth; [CONTRIBUTING.md](./CONTRIBUTING.md#developing) documents them, single-test invocation, the e2e prior-build requirement, and the CI matrix. Keep all CI jobs green.
Releases are automated via release-please; never hand-edit `CHANGELOG.md` or `.release-please-manifest.json`.

## Code map

- `src/cli.ts`: entry point - flags, config, stdin/worktree/resume setup, shutdown and exit summary.
- `src/core/run.ts`: `.gnhf/runs/<runId>/` metadata (kept local via `.git/info/exclude`).
- `src/core/orchestrator.ts`: the iteration loop, commit/rollback, backoff, usage-limit waits, and `RunLimits`.
- `src/renderer.ts`: alt-screen TUI driven by orchestrator events; `--mock` drives it offline via `src/mock-orchestrator.ts`.
- `src/core/agents/`: one module per agent implementing `Agent` in `types.ts`, picked by `factory.ts`. Start from `stream-utils.ts` for streaming and process lifecycle, and use `parseAgentOutput` to validate a new native agent's output.
- `src/core/config.ts`: `~/.gnhf/config.yml` loading; CLI flags override config.

## Invariants

- Any flag gnhf controls must be listed in `isReservedAgentArg` (`src/core/config.ts`) so user arg overrides cannot shadow it.
- All git calls go through `execFileSync` with explicit argv in `src/core/git.ts`; add a `git.injection.test.ts` case whenever new user input flows into git args.
- Worktree preservation (README "Worktree Mode") must hold on every exit path, including the `process.on("exit")` fallback and the force-exit timeout.
- A sleep inhibitor that fails to start or confirm must never abort a run.
- Raw ACP command specs are redacted to `acp:custom`/`custom` in debug logs, errors, and telemetry.
- `providerResumeWait` in the orchestrator is the single owner of what a provider-reported reset time is worth.
- Telemetry (`src/core/telemetry.ts`) sends one pageview at start and one `run` event at the end - never per-iteration, and never `cwd`, branch slug, prompt content, or anything identifying a user or repo. User-facing telemetry docs cover only the `GNHF_TELEMETRY=0` opt-out and that data is anonymous.

## Conventions

- ESM-only with `.js` import extensions in TypeScript source.
- Unit tests co-located as `*.test.ts`; e2e tests under `e2e/`. Prefer e2e for behavior crossing a process/IO boundary (CLI flags, config, git, agent spawning, stdout); unit-test pure helpers. Use TDD for bugfixes and features.
- Log lifecycle and error paths with `appendDebugLog("category:event", {...})` (`src/core/debug-log.ts`) rather than ad-hoc logging.
- No em dashes. No auto-added agent co-author lines in commits.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
