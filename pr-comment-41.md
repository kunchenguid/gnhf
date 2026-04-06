Reviewed and fixed before marking ready.

Fixes:

- cleared the text-agent startup timeout once output starts so active runs are not killed after 60s
- ensured AsyncAgentAdapter cleans up on failure and aborts promptly during poll sleep
- added regression coverage for both behaviors

Verified:

- `npx vitest run src/core/agents`
- 62/62 tests passing on this branch
