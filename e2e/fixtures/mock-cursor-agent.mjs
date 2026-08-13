#!/usr/bin/env node

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

function appendLog(details) {
  const logPath = process.env.GNHF_MOCK_CURSOR_LOG_PATH;
  if (!logPath) return;
  appendFileSync(
    logPath,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      pid: process.pid,
      ...details,
    })}\n`,
    "utf-8",
  );
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      body += chunk;
    });
    process.stdin.on("end", () => resolve(body));
    process.stdin.on("error", reject);
  });
}

const argv = process.argv.slice(2);
const stdin = await readStdin();

appendLog({
  event: "spawn",
  argv,
  cwd: process.cwd(),
  hasSchemaContract: stdin.includes("gnhf final output contract"),
  stdinHasObjective: stdin.includes("add a hello.txt via cursor agent"),
  stdinLen: stdin.length,
});

writeFileSync(
  join(process.cwd(), "hello.txt"),
  "hello from cursor mock\n",
  "utf-8",
);

const output = {
  success: true,
  summary: "cursor mock wrote hello.txt",
  key_changes_made: ["hello.txt"],
  key_learnings: ["cursor agent stream-json path works"],
};
const content = JSON.stringify(output);

process.stdout.write(
  `${JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "working..." }],
    },
  })}\n`,
);
process.stdout.write(
  `${JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: content }],
    },
  })}\n`,
);
process.stdout.write(
  `${JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: content,
    usage: {
      inputTokens: 12,
      outputTokens: 8,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  })}\n`,
);

appendLog({ event: "done", wrote: "hello.txt" });
process.exit(0);
