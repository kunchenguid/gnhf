Reviewed and fixed before marking ready.

Fixes:

- removed branch-inconsistent references to agents not present in this PR
- fixed the corrupted `factory.test.ts` block
- updated README/CLI/config text so the branch documents only what it actually ships

Verified:

- `npx vitest run src/core/agents/factory.test.ts`
- 7/7 focused tests passing
