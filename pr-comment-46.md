Reviewed and fixed before marking ready.

Fixes:

- carried over the text-agent timeout and async-adapter cleanup fixes
- removed accidental wiring for agents not actually present on this branch so the PR stands on its own
- aligned CLI/config/factory/tests with the branch's real scope

Verified:

- `npx vitest run src/core/agents/factory.test.ts src/core/agents/async-adapter.test.ts src/core/agents/text-based-agent.test.ts`
- 9/9 focused tests passing
