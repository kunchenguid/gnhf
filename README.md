<p align="center">Before I go to bed, I tell my agents:</p>
<h1 align="center">good night, have fun</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/gnhf"
    ><img
      alt="npm"
      src="https://img.shields.io/npm/v/gnhf?style=flat-square"
  /></a>
  <a href="https://github.com/kunchenguid/gnhf/actions/workflows/ci.yml"
    ><img
      alt="CI"
      src="https://img.shields.io/github/actions/workflow/status/kunchenguid/gnhf/ci.yml?style=flat-square&label=ci"
  /></a>
  <a href="https://github.com/kunchenguid/gnhf/actions/workflows/release-please.yml"
    ><img
      alt="Release"
      src="https://img.shields.io/github/actions/workflow/status/kunchenguid/gnhf/release-please.yml?style=flat-square&label=release"
  /></a>
  <a
    href="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square"
    ><img
      alt="Platform"
      src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square"
  /></a>
  <a href="https://x.com/kunchenguid"
    ><img
      alt="X"
      src="https://img.shields.io/badge/X-@kunchenguid-black?style=flat-square"
  /></a>
  <a href="https://discord.gg/Wsy2NpnZDu"
    ><img
      alt="Discord"
      src="https://img.shields.io/discord/1439901831038763092?style=flat-square&label=discord"
  /></a>
</p>

<p align="center">
  <img src="docs/splash.png" alt="gnhf — Good Night, Have Fun" width="800">
</p>

Never wake up empty-handed.

gnhf is a [ralph](https://ghuntley.com/ralph/), [autoresearch](https://github.com/karpathy/autoresearch)-style orchestrator that keeps your agents running while you sleep — each iteration makes one small, committed, documented change towards an objective.
You wake up to a branch full of clean work and a log of everything that happened.

- **Dead simple** — one command starts an autonomous loop that runs until you request stop or a configured runtime cap is reached
- **Long running** — each iteration is committed on success, rolled back on failure except commit failures preserved for repair, with sensible retries; retryable hard agent errors back off exponentially while agent-reported failures continue immediately
- **Live terminal title** — interactive runs keep your terminal title updated with live status, token totals, and commit count, then clear or restore it on exit depending on terminal support; token totals prefixed with `~` are estimates
- **Exit summary**: every run ends with a permanent summary covering elapsed time, branch, iterations, tokens, branch diff stats, local notes/log paths, and review commands
- **Agent-agnostic**: works with Claude Code, Codex, Rovo Dev, OpenCode, GitHub Copilot CLI, Pi, or ACP targets out of the box

## Quick Start

```sh
$ gnhf "reduce complexity of the codebase without changing functionality"
# have a good sleep
```

```sh
$ gnhf "reduce complexity of the codebase without changing functionality" \
    --max-iterations 10 \
    --max-tokens 5000000
# have a good nap
```

```sh
# Run multiple agents on the same repo simultaneously using worktrees
$ gnhf --worktree "implement feature X" &
$ gnhf --worktree "add tests for module Y" &
$ gnhf --worktree "refactor the API layer" &
```

```sh
# Commit directly on the current branch and push after each successful iteration
$ gnhf --current-branch --push "keep improving this app"
```

Run `gnhf` from inside a Git repository with a clean working tree. If you are starting from a plain directory, run `git init` first.
`gnhf` supports macOS, Linux, and Windows.

## Install

**npm**

```sh
npm install -g gnhf
```

**From source**

```sh
git clone https://github.com/kunchenguid/gnhf.git
cd gnhf
npm install
npm run build
npm link
```

## How It Works

```
                    ┌─────────────┐
                    │  gnhf start │
                    └──────┬──────┘
                           ▼
                ┌──────────────────────┐
                │  validate clean git  │
                │  create or use branch │
                │  write prompt.md     │
                └──────────┬───────────┘
                           ▼
              ┌────────────────────────────┐
              │  build iteration prompt    │◄──────────────┐
              │  (inject notes.md context) │               │
              └────────────┬───────────────┘               │
                           ▼                               │
              ┌────────────────────────────┐               │
              │  invoke your agent         │               │
              │  (non-interactive mode)    │               │
              └────────────┬───────────────┘               │
                           ▼                               │
                    ┌─────────────┐                        │
                    │  success?   │                        │
                    └──┬──────┬───┘                        │
                  yes  │      │  no                        │
                       ▼      ▼                            │
              ┌──────────┐  ┌───────────┐                  │
              │  commit  │  │ reset or  │                  │
              │  append  │  │  repair   │                  │
              │ notes.md │  │ maybe wait│                  │
              └────┬─────┘  └─────┬─────┘                  │
                   │              │                        │
                   │   ┌──────────┘                        │
                   ▼   ▼                                   │
              ┌────────────┐    yes   ┌──────────┐         │
              │ 3 consec.  ├─────────►│  abort   │         │
              │ failures   │          └────▲─────┘         │
              │ or perm.   ├───────────────┘               │
              │ error?     │                               │
              └─────┬──────┘                               │
                 no │                                      │
                    └──────────────────────────────────────┘
```

- **Incremental commits** - each successful iteration is a separate unsigned git commit, so you can cherry-pick or revert individual changes without GPG or SSH signing prompts blocking the run; if `git commit` fails, gnhf preserves the uncommitted work and asks the next agent iteration to repair it
- **Failure handling** - failed iterations are rolled back with `git reset --hard` except commit failures, which preserve uncommitted work for repair; agent-reported failures proceed to the next iteration immediately, retryable hard agent errors use exponential backoff, and permanent agent errors such as Claude low credit balance abort immediately and print the run log path. Complete no-op iterations are reported as failures and count toward the consecutive-failure abort limit. If the run exits with a pending commit failure, the exit summary warns that uncommitted changes were left for repair.
- **Runtime caps** - `--max-iterations` stops before the next iteration begins, `--max-tokens` can abort mid-iteration once reported usage reaches the cap, and `--stop-when` ends the loop after an iteration whose agent output reports the natural-language condition is met unless a commit failure needs repair first; resumed runs reuse the saved stop condition unless you pass a new value, or `--stop-when ""` to clear it; pending commit-failure repair work is preserved and other uncommitted work is rolled back, and in the interactive TUI the final state remains visible until you press Ctrl+C to exit
- **Iteration finalization** - agents are expected to finish validation, stop any background processes they started, and only then emit the final JSON result for the iteration
- **Graceful interrupts** - in the interactive TUI, the first Ctrl+C requests a graceful stop and lets the current iteration finish (or ends backoff early), the second Ctrl+C force-stops immediately, and `SIGTERM` also force-stops immediately
- **Exit summary** - after shutdown cleanup, gnhf prints a permanent stdout summary with the final branch, elapsed time, iteration and token totals, branch diff stats, notes/debug-log paths, and review commands
- **Shared memory** — the agent reads `notes.md` (built up from prior iterations) to communicate across iterations
- **Local run metadata** — gnhf stores prompt, notes, stop conditions, and commit-message convention metadata under `.gnhf/runs/` and ignores it locally, so your branch only contains intentional work
- **Resume support** — run `gnhf` while on an existing `gnhf/` branch to pick up where a previous run left off; if you provide a different prompt, gnhf asks whether to update the saved prompt and continue with the existing history, start a new branch, or quit. New runs whose generated branch already exists use a numeric suffix such as `gnhf/<slug>-1`.

### Live Branch Mode

Pass `--current-branch` to run on the branch you are already on instead of creating a `gnhf/` branch.
Pass `--push` to push the current branch after each successful iteration.
Together, `--current-branch --push` is useful for loose projects where you want a deployed or locally watched branch to update throughout the run.

- Push failures abort the run after preserving the successful local commit.
- gnhf never force-pushes or auto-pulls for this mode.
- `--push` also works with the default `gnhf/` branch mode and sets `origin` as the upstream when needed.
- Do not combine `--current-branch` with `--worktree`; gnhf exits with an error because those modes choose different working directories.

### Worktree Mode

Pass `--worktree` to run each agent in an isolated [git worktree](https://git-scm.com/docs/git-worktree). This lets you launch multiple agents on the same repo simultaneously — each gets its own working directory and branch without interfering with the others or your main checkout.

```
<repo>/                              ← your repo (unchanged)
<repo>-gnhf-worktrees/
  ├── <run-slug-1>/                  ← worktree for agent 1
  └── <run-slug-2>/                  ← worktree for agent 2
```

- Worktrees with commits are **preserved** after the run so you can review, merge, or cherry-pick the work. gnhf prints the path and cleanup command.
- Re-running the same prompt with `--worktree` resumes a preserved matching worktree when possible; otherwise gnhf creates a suffixed worktree such as `<run-slug>-1` if the original name is unavailable.
- Worktrees with **no commits** are automatically removed on exit unless a pending commit failure left uncommitted work to inspect or repair.
- `--worktree` must be run from a non-gnhf branch (typically `main`).

## CLI Reference

| Command                   | Description                                     |
| ------------------------- | ----------------------------------------------- |
| `gnhf "<prompt>"`         | Start a new run with the given objective        |
| `gnhf`                    | Resume a run (when on an existing gnhf/ branch) |
| `echo "<prompt>" \| gnhf` | Pipe prompt via stdin                           |
| `cat prd.md \| gnhf`      | Pipe a large spec or PRD via stdin              |

If you run `gnhf` on an existing `gnhf/` branch with a different prompt, gnhf asks whether to update `prompt.md` and continue the existing run history, start a new branch, or quit. When the prompt came from stdin, that confirmation is read from the controlling terminal, so it must be available.

### Flags

| Flag                     | Description                                                                                            | Default                |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------- |
| `--agent <agent>`        | Agent to use (`claude`, `codex`, `rovodev`, `opencode`, `copilot`, `pi`, or `acp:<target-or-command>`) | config file (`claude`) |
| `--max-iterations <n>`   | Abort after `n` total iterations                                                                       | unlimited              |
| `--max-tokens <n>`       | Abort after `n` total input+output tokens                                                              | unlimited              |
| `--stop-when <cond>`     | End when the agent reports this condition, after any commit-failure repair; persists across resume     | unlimited              |
| `--prevent-sleep <mode>` | Prevent system sleep during the run (`on`/`off` or `true`/`false`)                                     | config file (`on`)     |
| `--worktree`             | Run in a separate git worktree (enables multiple agents concurrently)                                  | `false`                |
| `--current-branch`       | Run on the current branch instead of creating a `gnhf/` branch                                         | `false`                |
| `--push`                 | Push the current branch after each successful iteration                                                | `false`                |
| `--meteor-frequency <n>` | Set TUI meteor frequency from 0 to 5 (`0` disables meteors)                                            | `3`                    |
| `--version`              | Show version                                                                                           |                        |

## Configuration

Config lives at `~/.gnhf/config.yml`:

```yaml
# Agent to use by default (claude, codex, rovodev, opencode, copilot, pi, or acp:<target-or-command>)
agent: claude

# Custom paths to native agent binaries (optional)
# agentPathOverride:
#   claude: /path/to/custom-claude
#   codex: /path/to/custom-codex
#   copilot: /path/to/custom-copilot
#   pi: /path/to/custom-pi

# Native agent CLI arg overrides (optional)
# agentArgsOverride:
#   codex:
#     - -m
#     - gpt-5.4
#     - -c
#     - model_reasoning_effort="high"
#     - --full-auto
#   copilot:
#     - --model
#     - gpt-5.4
#   pi:
#     - --provider
#     - openai-codex
#     - --model
#     - gpt-5.5
#     - --thinking
#     - high

# Custom ACP target commands (optional)
# acpRegistryOverrides:
#   my-fork: "/usr/local/bin/my-claude-code-fork --acp"
#   staging: "node /opt/staging/agent.mjs"

# Commit message convention (optional)
# Defaults to: gnhf <iteration>: <summary>
# Use the conventional preset for semantic-release compatible headers:
# commitMessage:
#   preset: conventional

# Abort after this many consecutive failures
maxConsecutiveFailures: 3

# Prevent the machine from sleeping during a run
preventSleep: true
```

If the file does not exist yet, `gnhf` creates it on first run using the resolved defaults.

CLI flags override config file values. `--prevent-sleep` accepts `on`/`off` as well as `true`/`false`; the config file always uses a boolean.
The iteration and token caps are runtime-only flags and are not persisted in `config.yml`; `--stop-when` is persisted per run for resume, but not in config.

`agentArgsOverride.<name>` lets you pass through extra CLI flags for native agents (`claude`, `codex`, `rovodev`, `opencode`, `copilot`, or `pi`).
ACP targets do not support path or arg overrides in this version.
Use `acpRegistryOverrides` to map `acp:<target>` names to custom spawn commands for local, forked, or beta ACP agents.
You can also pass a raw custom ACP server command directly as a quoted `acp:` spec, for example `gnhf --agent 'acp:./bin/dev-acp --profile ci' "fix the tests"`.

- Use it for agent-specific options like models, profiles, or reasoning settings without adding a dedicated `gnhf` config field for each one.
- For `codex`, `claude`, and `copilot`, `gnhf` adds its usual non-interactive permission default only when you do not provide your own permission or execution-mode flag. If you set one explicitly, `gnhf` treats that as user-managed and does not add its default on top.
- Flags that `gnhf` manages itself for a given agent, such as output-shaping or local-server startup flags, are rejected during config loading so you get a clear error instead of duplicate-argument ambiguity. For `pi` specifically, `--api-key` is also blocked; configure the Pi API key via Pi's own config or the environment variable it reads, not via `agentArgsOverride`.

`commitMessage` controls the subject line that gnhf uses for each successful iteration commit.

- Omit it to keep the default `gnhf <iteration>: <summary>` format.
- Set `preset: conventional` to ask the agent for `type` and optional `scope`, then commit as `type(scope): summary` for semantic-release style workflows. Valid types are `build`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `test`, and `chore`; invalid or missing types fall back to `chore`, and empty scopes are omitted.
- The resolved commit-message convention is saved per run, so resuming a `gnhf/` branch keeps the original subject format even if `config.yml` changes later.

### Custom Agent Paths

Use `agentPathOverride` to point any native agent at a custom binary - useful for wrappers like Claude Code Switch or custom Codex builds that accept the same flags and arguments as the original:

```yaml
agentPathOverride:
  claude: ~/bin/claude-code-switch
  codex: /usr/local/bin/my-codex-wrapper
  copilot: ~/bin/copilot-wrapper
  pi: ~/bin/pi-wrapper
```

Paths may be absolute, bare executable names already on your `PATH`, `~`-prefixed, or relative to the config directory (`~/.gnhf/`). The override replaces only the binary name; all standard arguments are preserved, so the replacement must be CLI-compatible with the original agent. On Windows, `.cmd` and `.bat` wrappers are supported, including bare names resolved from `PATH`. For `rovodev`, the override must point to an `acli`-compatible binary since gnhf invokes it as `<bin> rovodev serve ...`.
When sleep prevention is enabled, `gnhf` uses the native mechanism for your OS: `caffeinate` on macOS, `systemd-inhibit` on Linux, and a small PowerShell helper backed by `SetThreadExecutionState` on Windows.

## Debug Logs

Every run writes a JSONL debug log to `.gnhf/runs/<runId>/gnhf.log` alongside `notes.md`. Lifecycle events for the orchestrator, agent, and HTTP requests are captured with elapsed timings and (for failures) the full `error.cause` chain, which is what you need to tell a bare `TypeError: fetch failed` apart from an undici `UND_ERR_HEADERS_TIMEOUT`. The agent's own streaming output still goes to the per-iteration `iteration-<n>.jsonl` file next to it.
Raw ACP command specs are redacted as `acp:custom`/`custom` in debug logs and related errors, so local paths or secrets in custom commands are not written to `gnhf.log`.

Including a snippet of `gnhf.log` is the single most useful thing you can attach when filing an issue.

## Telemetry

`gnhf` sends anonymous usage telemetry to my self-hosted analytics so I can see what's actually getting used.
No prompts, repo paths, or branch names are sent.
Set `GNHF_TELEMETRY=0` to turn it off.

## Agents

`gnhf` supports six native agents plus ACP targets. ACP support is powered by [`acpx`](https://github.com/openclaw/acpx), which is bundled with `gnhf` and provides the runtime and agent registry for `acp:<target-or-command>` specs.

| Agent              | Flag                              | Requirements                                                                                                                                                                        | Notes                                                                                                                                                                                                                                                                                                       |
| ------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code        | `--agent claude`                  | Install Anthropic's `claude` CLI and sign in first.                                                                                                                                 | `gnhf` invokes `claude` directly in non-interactive mode. After Claude emits a successful structured result, `gnhf` treats that result as final and shuts down any lingering Claude process tree after a short grace period.                                                                                |
| Codex              | `--agent codex`                   | Install OpenAI's `codex` CLI and sign in first.                                                                                                                                     | `gnhf` invokes `codex exec` directly in non-interactive mode.                                                                                                                                                                                                                                               |
| GitHub Copilot CLI | `--agent copilot`                 | Install GitHub Copilot CLI and sign in first.                                                                                                                                       | `gnhf` invokes `copilot` directly in non-interactive JSONL mode. Copilot currently exposes assistant output tokens, but not full input/cache token totals; see https://github.com/github/copilot-cli/issues/1152.                                                                                           |
| Pi                 | `--agent pi`                      | Install the `pi` CLI and configure a usable provider/model first.                                                                                                                   | `gnhf` invokes `pi` directly in JSON mode, appends the final output schema to the prompt, and disables Pi session persistence with `--no-session`.                                                                                                                                                          |
| Rovo Dev           | `--agent rovodev`                 | Install Atlassian's `acli` and authenticate it with Rovo Dev first.                                                                                                                 | `gnhf` starts a local `acli rovodev serve --disable-session-token <port>` process automatically in the repo workspace.                                                                                                                                                                                      |
| OpenCode           | `--agent opencode`                | Install `opencode` and configure at least one usable model provider first.                                                                                                          | `gnhf` starts a local `opencode serve --hostname 127.0.0.1 --port <port> --print-logs` process automatically, creates a per-run session, and applies a blanket allow rule so tool calls do not block on prompts.                                                                                            |
| ACP target         | `--agent acp:<target-or-command>` | Install and authenticate the target supported by the bundled [`acpx`](https://github.com/openclaw/acpx) registry, such as `acp:gemini`, or pass a quoted custom ACP server command. | `gnhf` runs the target through ACP with a persistent per-run session under `.gnhf/runs/<runId>/acp-sessions`; token usage and `--max-tokens` use ACP `used` deltas when available, with prompt-length plus tool-call estimates as a fallback, and `agentPathOverride` and `agentArgsOverride` do not apply. |

## Development

If you want to contribute changes back to this repo, see [`CONTRIBUTING.md`](./CONTRIBUTING.md). Human-authored PRs targeting `main` must be opened via `git push no-mistakes` so the required `Require no-mistakes` check passes.

```sh
npm run build          # Build with tsdown
npm run dev            # Watch mode
npm test               # Build, then run all tests (vitest)
npm run test:e2e       # Build, then run end-to-end tests against the mock opencode executable
npm run lint           # ESLint
npm run format         # Prettier
```

## Star History

<a href="https://www.star-history.com/?repos=kunchenguid%2Fgnhf&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=kunchenguid/gnhf&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=kunchenguid/gnhf&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=kunchenguid/gnhf&type=date&legend=top-left" />
 </picture>
</a>
