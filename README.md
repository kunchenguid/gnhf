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

- **Dead simple** — one command starts an autonomous loop that runs until you Ctrl+C or a configured runtime cap is reached
- **Long running** — each iteration is committed on success, rolled back on failure, with sensible retries and exponential backoff
- **Agent-agnostic** — works with Claude Code, Codex, Rovo Dev, or OpenCode out of the box

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
                │  create gnhf/ branch │
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
              │  commit  │  │ git reset │                  │
              │  append  │  │  --hard   │                  │
              │ notes.md │  │  backoff  │                  │
              └────┬─────┘  └─────┬─────┘                  │
                   │              │                        │
                   │   ┌──────────┘                        │
                   ▼   ▼                                   │
              ┌────────────┐    yes   ┌──────────┐         │
              │ 3 consec.  ├─────────►│  abort   │         │
              │ failures?  │          └──────────┘         │
              └─────┬──────┘                               │
                 no │                                      │
                    └──────────────────────────────────────┘
```

- **Incremental commits** — each successful iteration is a separate git commit, so you can cherry-pick or revert individual changes
- **Runtime caps** — `--max-iterations` stops before the next iteration begins, while `--max-tokens` can abort mid-iteration once reported usage reaches the cap; uncommitted work is rolled back in either case, and in the interactive TUI the final state remains visible until you press Ctrl+C to exit
- **Shared memory** — the agent reads `notes.md` (built up from prior iterations) to communicate across iterations
- **Local run metadata** — gnhf stores prompt, notes, and resume metadata under `.gnhf/runs/` and ignores it locally, so your branch only contains intentional work
- **Resume support** — run `gnhf` while on an existing `gnhf/` branch to pick up where a previous run left off

## CLI Reference

| Command                   | Description                                     |
| ------------------------- | ----------------------------------------------- |
| `gnhf "<prompt>"`         | Start a new run with the given objective        |
| `gnhf`                    | Resume a run (when on an existing gnhf/ branch) |
| `echo "<prompt>" \| gnhf` | Pipe prompt via stdin                           |
| `cat prd.md \| gnhf`      | Pipe a large spec or PRD via stdin              |

### Flags

| Flag                     | Description                                                        | Default                |
| ------------------------ | ------------------------------------------------------------------ | ---------------------- |
| `--agent <agent>`        | Agent to use (`claude`, `codex`, `rovodev`, or `opencode`)         | config file (`claude`) |
| `--max-iterations <n>`   | Abort after `n` total iterations                                   | unlimited              |
| `--max-tokens <n>`       | Abort after `n` total input+output tokens                          | unlimited              |
| `--prevent-sleep <mode>` | Prevent system sleep during the run (`on`/`off` or `true`/`false`) | config file (`on`)     |
| `--version`              | Show version                                                       |                        |

## Configuration

Config lives at `~/.gnhf/config.yml`:

```yaml
# Agent to use by default (claude, codex, rovodev, or opencode)
agent: claude

# Custom paths to agent binaries (optional)
# agentPathOverride:
#   claude: /path/to/custom-claude
#   codex: /path/to/custom-codex

# Abort after this many consecutive failures
maxConsecutiveFailures: 3

# Prevent the machine from sleeping during a run
preventSleep: true
```

If the file does not exist yet, `gnhf` creates it on first run using the resolved defaults.

CLI flags override config file values. `--prevent-sleep` accepts `on`/`off` as well as `true`/`false`; the config file always uses a boolean.
The iteration and token caps are runtime-only flags and are not persisted in `config.yml`.

### Custom Agent Paths

Use `agentPathOverride` to point any agent at a custom binary — useful for wrappers like Claude Code Switch or custom Codex builds that accept the same flags and arguments as the original:

```yaml
agentPathOverride:
  claude: ~/bin/claude-code-switch
  codex: /usr/local/bin/my-codex-wrapper
```

Paths may be absolute, bare executable names already on your `PATH`, `~`-prefixed, or relative to the config directory (`~/.gnhf/`). The override replaces only the binary name; all standard arguments are preserved, so the replacement must be CLI-compatible with the original agent. On Windows, `.cmd` and `.bat` wrappers are supported, including bare names resolved from `PATH`. For `rovodev`, the override must point to an `acli`-compatible binary since gnhf invokes it as `<bin> rovodev serve ...`.
When sleep prevention is enabled, `gnhf` uses the native mechanism for your OS: `caffeinate` on macOS, `systemd-inhibit` on Linux, and a small PowerShell helper backed by `SetThreadExecutionState` on Windows.

## Debug Logs

Set `GNHF_DEBUG_LOG_PATH` to capture lifecycle events as JSONL while debugging a run:

```sh
GNHF_DEBUG_LOG_PATH=/tmp/gnhf-debug.jsonl gnhf "ship it"
```

## Agents

`gnhf` supports four agents:

| Agent       | Flag               | Requirements                                                               | Notes                                                                                                                                                                                                            |
| ----------- | ------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `--agent claude`   | Install Anthropic's `claude` CLI and sign in first.                        | `gnhf` invokes `claude` directly in non-interactive mode.                                                                                                                                                        |
| Codex       | `--agent codex`    | Install OpenAI's `codex` CLI and sign in first.                            | `gnhf` invokes `codex exec` directly in non-interactive mode.                                                                                                                                                    |
| Rovo Dev    | `--agent rovodev`  | Install Atlassian's `acli` and authenticate it with Rovo Dev first.        | `gnhf` starts a local `acli rovodev serve --disable-session-token <port>` process automatically in the repo workspace.                                                                                           |
| OpenCode    | `--agent opencode` | Install `opencode` and configure at least one usable model provider first. | `gnhf` starts a local `opencode serve --hostname 127.0.0.1 --port <port> --print-logs` process automatically, creates a per-run session, and applies a blanket allow rule so tool calls do not block on prompts. |

## Development

```sh
npm run build          # Build with tsdown
npm run dev            # Watch mode
npm test               # Build, then run unit tests (vitest)
npm run test:e2e       # Build, then run end-to-end tests against the mock opencode executable
npm run lint           # ESLint
npm run format         # Prettier
```
