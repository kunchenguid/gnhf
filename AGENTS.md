# AGENTS.md

This file provides guidance to agents1 when working with code in this repository.

## Project

`gnhf` ("good night, have fun") is a CLI that runs a coding agent (Claude Code, Codex, Rovo Dev, OpenCode, GitHub Copilot CLI, or Pi) in a loop inside a git repo. Each successful iteration is a separate commit on a dedicated `gnhf/<slug>` branch; failures get `git reset --hard`, retryable hard agent errors trigger exponential backoff, and permanent agent errors abort immediately. Target: Node 20+, published to npm as a single-file ESM bundle.

## Commands

```sh
npm run build          # tsdown bundle → dist/cli.mjs (the published binary)
npm run dev            # tsdown --watch
npm run lint           # ESLint on src
npm run format         # Prettier on src (format:check for CI)
npm run typecheck      # tsc -p tsconfig.typecheck.json --noEmit
npm test               # build, then vitest run (all tests)
npm run test:e2e       # build, then vitest run test/e2e.test.ts
npm run test:coverage  # vitest with coverage, excludes the e2e test
```

Run a single test file: `npx vitest run src/core/orchestrator.test.ts`. Filter by name: `npx vitest run -t "name substring"`. Unit tests live next to source as `*.test.ts`; the e2e test under `test/e2e.test.ts` shells out to the built `dist/cli.mjs` against a mock `opencode` server in `test/fixtures/`, so it requires a prior build (`npm test` and `npm run test:e2e` do this automatically).

CI (`.github/workflows/ci.yml`) runs lint, format:check, typecheck, and test on Ubuntu/macOS/Windows with Node 24 - keep all four green. Releases are automated via release-please; never hand-edit `CHANGELOG.md` or `.release-please-manifest.json`.

## Architecture

Entry point is `src/cli.ts`. It parses flags with commander, resolves config, handles stdin/worktree/resume setup, then hands off to the orchestrator. Everything else is plain modules under `src/`.

### Run lifecycle (the critical flow)

1. `cli.ts` decides one of three modes: new branch, resume an existing `gnhf/<slug>` branch, or `--worktree` (creates a sibling `<repo>-gnhf-worktrees/<slug>/` checkout). New branch and worktree runs probe numeric suffixes such as `gnhf/<slug>-1` and `<repo>-gnhf-worktrees/<slug>-1/` on collisions; worktree mode also resumes preserved suffixed worktrees before creating a new one. When resuming with a different prompt, it asks whether to update `prompt.md` and continue the existing run history, start a new branch, or quit; if stdin is piped, that confirmation comes from the controlling terminal before any sleep-prevention re-exec. `setupRun`/`resumeRun` in `src/core/run.ts` create `.gnhf/runs/<runId>/` with `prompt.md`, `notes.md`, `output-schema.json`, `base-commit`, optional `stop-when`, `commit-message`, and `gnhf.log`, and add `.gnhf/runs/` to `.git/info/exclude` so run metadata stays local.
2. `Orchestrator` (`src/core/orchestrator.ts`) is an `EventEmitter` loop. Each iteration: build prompt via `src/templates/iteration-prompt.ts` (injects current `notes.md`), call `agent.run(...)`, then on success `commitAll` + append to `notes.md`; on failure `resetHard`. Agent-reported failures continue immediately, retryable thrown agent errors increment the backoff streak, and `PermanentAgentError` aborts immediately after rollback with `lastAgentError` set for the renderer. Three consecutive failures abort. The `RunLimits` object enforces `--max-iterations` (between iterations), `--max-tokens` (mid-iteration via AbortController), and `--stop-when` (post-iteration, honored on both successful and failed iterations when the agent sets `should_fully_stop` in its output).
3. `Renderer` (`src/renderer.ts` + `src/renderer-diff.ts`) is a cell-based TUI using the alt screen buffer. `cli.ts` enters/exits alt screen around it. The renderer subscribes to orchestrator events, diffs frames to minimize writes, and updates the terminal title live. `MockOrchestrator` (`src/mock-orchestrator.ts`) drives the renderer offline via `--mock` for demos/testing.
4. Shutdown path: `SIGINT` routes through `orchestrator.handleInterrupt()`. The first press requests a graceful stop, letting the current iteration finish or ending backoff early; the second press force-stops via `orchestrator.stop()`. `SIGTERM` force-stops immediately. `cli.ts` only keeps the done screen open for aborted runs; graceful stops exit once shutdown cleanup finishes. If it's a `--worktree` run with zero commits, the worktree is removed; otherwise it's preserved and the path is printed.

### Agents (`src/core/agents/`)

Each agent implements the `Agent` interface in `types.ts` (`name`, async `run(prompt, cwd, options)` returning `{ output, usage }`, optional `close()`). They share two responsibilities: stream stdout, extract a structured `AgentOutput` (`success`, `summary`, `key_changes_made`, `key_learnings`, commit-message fields when configured, plus `should_fully_stop` only when `--stop-when` is active) that matches the schema built by `buildAgentOutputSchema(...)`, and accumulate `TokenUsage`. `factory.ts` picks one based on config.

- `claude.ts` / `codex.ts` / `copilot.ts` / `pi.ts`: spawn the CLI per iteration in non-interactive mode. Codex uses `--output-schema` pointing at the run's schema file; Claude uses `--json-schema`, treats the last successful structured result as terminal, raises `PermanentAgentError` for low credit balance exits, and after a short grace period shuts down a lingering Claude process tree if it stays alive. Copilot uses JSONL output plus prompt-level schema instructions, then parses the final `assistant.message` content. Pi runs in JSON mode, appends the final output schema to the prompt, and parses the assistant JSON reply from Pi's streamed events.
- `rovodev.ts` / `opencode.ts`: long-running local HTTP servers managed via `managed-process.ts` (start once, reuse across iterations, close on shutdown). OpenCode creates a per-run session and applies a blanket allow rule to avoid prompt blocking.
- `stream-utils.ts`: shared JSONL parsing, `AbortSignal` wiring, and child-process lifecycle helpers. When touching agent streaming, start here.

Reserved args managed by gnhf are rejected in `config.ts` via `isReservedAgentArg` - if you add a new flag that gnhf controls, add it to that list so user overrides can't shadow it.

### Config (`src/core/config.ts`)

Loads `~/.gnhf/config.yml` (bootstrapped on first run). CLI flags override config; runtime-only flags (`--max-iterations`, `--max-tokens`, `--stop-when`) are never persisted to config. `--stop-when` is persisted per run for resume. `agentPathOverride` and `agentArgsOverride` are per-agent; paths resolve relative to `~/.gnhf/` and support `~` expansion. `commitMessage.preset: conventional` adds commit-message fields to the output schema/prompt and changes successful-iteration commit subjects; the resolved convention is persisted per run so resume does not silently switch formats after config changes.

### Git helpers (`src/core/git.ts`)

All git invocations go through `execFileSync` with explicit argv. `git.injection.test.ts` guards against shell-metachar leakage via branch names and prompts - add a case there whenever you accept new user input that flows into git args.

### Sleep prevention (`src/core/sleep.ts`)

When `preventSleep` is on and the process wasn't already re-exec'd under a sleep-inhibitor, gnhf re-execs itself under `caffeinate` (macOS), `systemd-inhibit` (Linux), or a PowerShell `SetThreadExecutionState` helper (Windows). The re-exec uses `GNHF_SLEEP_INHIBITED=1` as the loop-breaker and `GNHF_REEXEC_STDIN_PROMPT_FILE` to pass piped stdin across the re-exec (the original process writes a 0600 temp file, the child reads and unlinks it).

## Conventions

- ESM-only, `.js` import extensions in TypeScript source (`import { foo } from "./foo.js"`). tsdown bundles it all into `dist/cli.mjs`.
- Tests co-located as `*.test.ts`; use TDD for bugfixes and new features.
- Error paths matter - `debug-log.ts` writes JSONL lifecycle events to `.gnhf/runs/<id>/gnhf.log` with full `error.cause` chains. Prefer `appendDebugLog("category:event", {...})` over ad-hoc logging.
- No em dashes ("-"). No auto-added Claude co-author lines in commits.
