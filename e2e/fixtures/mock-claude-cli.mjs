#!/usr/bin/env node

// Stands in for the `claude` CLI. GNHF_MOCK_CLAUDE_MODE picks the stream
// shape, so one fixture covers every combination: the failure shapes the error
// paths need, plus successful runs that first announce the included usage
// window is spent and requests are being billed to extra usage.

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const mode = process.env.GNHF_MOCK_CLAUDE_MODE ?? "stdout-error";

if (mode === "no-output") {
  process.exit(1);
}

if (mode === "stderr-error") {
  process.stderr.write("Invalid API key - please run /login\n");
  process.exit(1);
}

if (mode === "overage-elapsed-reset" || mode === "overage-no-reset") {
  // Real work for the orchestrator to commit, so the extra-usage decision is
  // taken after a genuinely successful, committed iteration.
  writeFileSync(
    join(process.cwd(), `overage-${randomUUID()}.txt`),
    "billed to extra usage\n",
    "utf-8",
  );

  const rateLimitInfo = { status: "allowed", isUsingOverage: true };
  if (mode === "overage-elapsed-reset") {
    // An hour behind us: the included window has already come back.
    rateLimitInfo.resetsAt = Math.floor(Date.now() / 1000) - 3600;
  }

  process.stdout.write(
    `${JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: rateLimitInfo,
    })}\n${JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0,
      usage: {
        input_tokens: 12,
        output_tokens: 7,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      structured_output: {
        success: true,
        summary: "did the work while billed to extra usage",
        key_changes_made: ["added a file"],
        key_learnings: [],
      },
    })}\n`,
  );
  process.exit(0);
}

process.stdout.write(
  `${JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "Invalid model name: claude-nonexistent-5",
  })}\n`,
);
process.exit(1);
