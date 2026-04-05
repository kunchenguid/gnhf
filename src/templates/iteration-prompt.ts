export function buildIterationPrompt(params: {
  n: number;
  runId: string;
  prompt: string;
}): string {
  return `You are working autonomously towards an objective given below.
This is iteration ${params.n}. Each iteration aims to make an incremental step forward, not to complete the entire objective.

## Instructions

1. Read .gnhf/runs/${params.runId}/notes.md first to understand what has been done in previous iterations
2. Identify the next smallest logical unit of work that's individually verifiable and would make incremental progress towards the objective, and treat that as the scope of this iteration
3. If you attempted a solution and it didn't end up moving the needle on the objective, document learnings and record success=false, then conclude the iteration rather than continuously pivoting
4. If you made code changes, run build/tests/linters/formatters if available to validate your work. Do NOT make any git commits - that will be handled automatically by the gnhf orchestrator
6. Finally, respond with a JSON object according to the provided schema

## Output

- success: whether you were able to make a meaningful contribution that got us closer towards the objective. setting this to false means any code change you made should be discarded
- summary: a concise one-sentence summary of the accomplishment in this iteration
- key_changes_made: an array of descriptions for key changes you made. don't group this by file - group by logical units of work. don't describe activities - describe material outcomes
- key_learnings: an array of new learnings that were surprising, weren't captured by previous notes and would be informative for future iterations

## Objective

${params.prompt}`;
}
