#!/usr/bin/env node

// Stands in for xAI's `grok` CLI in non-interactive mode: it records the argv
// gnhf built, edits the workspace like a real agent turn would, and replays
// grok's `--output-format streaming-json` event stream on stdout.

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

function appendLog(event, details = {}) {
  const logPath = process.env.GNHF_MOCK_GROK_LOG_PATH;
  if (!logPath) return;
  appendFileSync(
    logPath,
    `${JSON.stringify({ pid: process.pid, event, ...details })}\n`,
    "utf-8",
  );
}

function readFlag(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const argv = process.argv.slice(2);
const prompt = readFlag(argv, "-p");
const schema = readFlag(argv, "--json-schema");

appendLog("cli:invoked", {
  argv,
  prompt,
  schema,
  outputFormat: readFlag(argv, "--output-format"),
  alwaysApprove: argv.includes("--always-approve"),
  cwd: process.cwd(),
});

const marker = `- grok change ${argv.length}-${process.pid}\n`;
appendFileSync(join(process.cwd(), "README.md"), marker, "utf-8");
appendLog("workspace:changed", { marker: marker.trim() });

const output = {
  success: true,
  summary: "appended a mock grok change to README.md",
  key_changes_made: ["README.md: appended one line"],
  key_learnings: ["the mock grok CLI streams events as JSONL"],
};

emit({ type: "text", data: "Reading README.md" });
emit({ type: "text", data: " and appending one line...\n" });

const usage = {
  input_tokens: 1200,
  cache_read_input_tokens: 300,
  output_tokens: 450,
  reasoning_tokens: 150,
  total_tokens: 2100,
};

if (process.env.GNHF_MOCK_GROK_TEXT_ONLY === "1") {
  // Some grok builds print the JSON answer as prose instead of populating
  // `structuredOutput`; gnhf must still recover the schema-shaped object.
  emit({
    type: "text",
    data: `\n\`\`\`json\n${JSON.stringify(output)}\n\`\`\`\n`,
  });
  emit({ type: "end", stopReason: "stop", usage });
} else {
  emit({ type: "end", stopReason: "stop", usage, structuredOutput: output });
}

appendLog("cli:exit", { code: 0 });
process.exit(0);
