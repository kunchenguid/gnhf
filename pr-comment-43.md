Reviewed and fixed before marking ready.

Fixes:

- removed duplicated async-agent type definitions
- wired Jules into config, CLI, and factory on this branch
- removed the broken standalone Jules polling path so it runs via AsyncAgentAdapter
- surfaced Jules pull request URL from completed sessions

Verified:

- `npx vitest run src/core/agents/factory.test.ts`
- targeted branch checks passing
