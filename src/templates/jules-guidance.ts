export const JULES_GUIDANCE = [
  "Jules CLI/tooling is available.",
  "Use it selectively: it runs remotely, is slower than local work, and creates its own branch and PR.",
  "Prefer Jules for isolated, longer-running tasks where a separate remote branch/PR is useful, such as broad codebase analysis, parallelizable implementation spikes, or self-contained refactors.",
  "Do not use Jules for quick local edits, tight test-fix loops, or work that depends on rapid iteration in the current branch.",
  "You remain responsible for verifying any Jules result.",
] as const;

export function buildJulesGuidance(): string {
  return JULES_GUIDANCE.join(" ");
}
