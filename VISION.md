# Vision

`gnhf` exists so that the hours its user spends asleep become committed, reviewable work.
It serves a developer who points a coding agent at a repository at night and reviews a branch in the morning.
It owns exactly one thing: the unattended loop that turns agent iterations into small, safe, documented git commits.

## No work is ever lost

Work that was made is never silently destroyed.
Every successful iteration is its own commit, so a night's work can be reviewed, cherry-picked, or reverted one change at a time.
A failed commit preserves the workspace and asks the next iteration to repair it instead of hard-resetting it away.
A forced shutdown still keeps the final agent output, successful recordings, and any worktree that holds commits.
A push failure aborts the run only after the local commit is safe.
A change that can lose user work in an edge case is a bug of the highest class and gets fixed at the root.

## The user holds the leash

An unattended loop earns trust through explicit limits, live control, and staying alive until morning.
Iteration caps, token caps, and natural-language stop conditions bound every run, and stop conditions survive resume.
The first interrupt is graceful and lets the iteration finish; the second is immediate.
Steering a live run and reviewing a finished run's commits are user control, not scope creep.
The run defends itself against whatever would end the night early: machine sleep, a closed terminal, transient agent failures.
Anything that can silently hang an unattended run, such as an interactive credential prompt, is refused until it works unattended.
Permanent errors, such as an exhausted credit balance, abort at once rather than burning the night in retries.
gnhf never force-pushes, never auto-pulls, and never starts on a working tree it cannot protect.
New autonomy is welcome only when it arrives with a limit the user can set and an interrupt that still works.

## Small surface, wide reach

gnhf is agent-agnostic: the loop, not any one vendor's CLI, is the product.
The extension path for new agents is ACP; a new agent arrives as an `acp:` target or a registry override, not as new adapter code.
A native adapter is permanent maintainer surface, so the native roster shrinks over time rather than grows.
A native adapter is retired only when its ACP path keeps every key capability the native path had.
Messy agent output is a fact of the ecosystem, so adapters recover schema-valid results from prose and fences before declaring an iteration lost.
When an agent fails, the real error surfaces with its full cause chain instead of being swallowed into a generic message.
Surface saved on vendors is spent on users: serving more users with the same product is almost always desired.
More operating systems and more install channels are welcome, and a shipped platform is never dropped to save maintenance.

## Nothing identifiable leaves the machine

Prompts, notes, run metadata, and logs live under `.gnhf/runs/` and stay local, so the branch only contains intentional work.
Telemetry is anonymous, never carrying prompts, paths, or branch names, and a single env var turns it off.
Richer diagnostics are welcome when they are opt-in, stay anonymous, and change nothing for anyone who does not enable them.
Raw agent commands are redacted from logs, errors, and telemetry so local paths and secrets are never written out.
Publishing is always an explicit user choice, such as `--push`.

## Delight is part of the contract

The name is a bedtime ritual, and the TUI honors it with a star field, meteors, and a live terminal title.
Delight never costs control: every flourish has a frequency dial or an off switch, and the terminal is restored on exit.
A misaligned summary, a dropped animation, or a title left dirty after exit is treated as a real bug.

## Scope

gnhf is not a coding agent, and it does not compete with the agents it runs.
It presents the night's work for the user's judgment but never judges it: it is not a CI system, not a reviewer, and not a merge authority.
It does not own what another layer already owns: opening PRs belongs to outer automation, verification belongs to agent hooks, parallelism is running multiple instances, and objectives are the user's own prompts.
It is a local, single-user CLI, not a hosted service or a team platform.
The repo holds itself to the bar it sets for agents: e2e tests over mocks at process boundaries, an enforced PR pipeline, automated releases, and one authoritative owner per documented fact.

A change aligns when it makes an unattended run safer, longer-lived, more steerable, or more legible in the morning, or brings the same product to more users.
A change should be resisted when it could hang an unattended run, loses a capability an agent integration already had, duplicates what an outer layer or an agent hook already owns, or sends anything identifiable off the machine.
