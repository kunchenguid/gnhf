Reviewed and fixed before marking ready.

Fixes:

- corrected the OpenCode health-check no-signal abort path
- removed malformed request-header control flow in `opencode.ts`
- added coverage for successful startup without an external signal and for request header merging

Verified:

- `npx vitest run src/core/agents/opencode.test.ts src/core/agents/kilo.test.ts`
- 23/23 targeted tests passing
