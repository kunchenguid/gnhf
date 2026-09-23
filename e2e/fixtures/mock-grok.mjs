#!/usr/bin/env node

// Stands in for xAI's `grok` CLI in `-p --output-format streaming-json` mode,
// replaying the event shapes grok 1.0.41 emits. GNHF_MOCK_GROK_MODE picks
// between a successful turn and the signed-out failure.

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const mode = process.env.GNHF_MOCK_GROK_MODE ?? "success";
const argv = process.argv.slice(2);

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const logPath = process.env.GNHF_MOCK_GROK_LOG_PATH;
if (logPath) {
  const schemaIndex = argv.indexOf("--json-schema");
  appendFileSync(
    logPath,
    `${JSON.stringify({
      event: "spawn",
      argv: argv.map((arg, index) =>
        argv[index - 1] === "-p"
          ? "<prompt>"
          : index === schemaIndex + 1
            ? "<schema>"
            : arg,
      ),
      promptHasObjective: argv[argv.indexOf("-p") + 1]?.includes(
        "add a hello.txt via grok",
      ),
      schemaRequired: JSON.parse(argv[schemaIndex + 1]).required,
    })}\n`,
    "utf-8",
  );
}

if (mode === "signed-out") {
  const message =
    "Not signed in. To authenticate without a browser, run:\n  grok login --device-code";
  emit({ type: "error", message });
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

writeFileSync(join(process.cwd(), "hello.txt"), "hello from grok mock\n");

emit({ type: "thought", data: "Writing hello.txt" });
emit({ type: "text", data: "Creating" });
emit({ type: "text", data: " hello.txt" });
emit({
  type: "usage",
  usage: {
    input_tokens: 1000,
    output_tokens: 40,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_tokens: 10,
  },
});
emit({
  type: "tool_call",
  toolCallId: "call-1",
  toolName: "run_terminal_command",
  status: "pending",
});
emit({
  type: "usage",
  usage: {
    input_tokens: 50,
    output_tokens: 60,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 0,
    reasoning_tokens: 20,
  },
});
emit({
  type: "end",
  stopReason: "end_turn",
  sessionId: "01a0cbfc-44c3-7a51-8b07-6e9cc6e90ca6",
  usage: {
    input_tokens: 1050,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 0,
    output_tokens: 100,
    reasoning_tokens: 30,
    total_tokens: 2050,
  },
  num_turns: 2,
  structuredOutput: {
    success: true,
    summary: "grok mock wrote hello.txt",
    key_changes_made: ["hello.txt"],
    key_learnings: ["grok streaming-json path works"],
  },
});
process.exit(0);
