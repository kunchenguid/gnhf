# CLAUDE.md

## Project

gnhf — an agent-agnostic autonomous coding orchestrator that runs iterative agent loops with git-based checkpointing.

## Design Doc Rule

Every feature change must have a design doc in `docs/design/`. Name files as `NNN-short-description.md` with sequential numbering. Write the design doc before or during implementation — never skip it. Update the index in `docs/design/README.md` when adding a new entry.

## Development

- Build: `npm run build`
- Test: `npm test`
- Lint: `npm run lint`
- Format: `npm run format`
- E2E tests: `npm run test:e2e`
