#!/usr/bin/env node

import console from "node:console";
import { Buffer } from "node:buffer";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import process from "node:process";
import { setTimeout } from "node:timers";

function appendLog(event, details = {}) {
  const logPath = process.env.GNHF_MOCK_OPENCODE_LOG_PATH;
  if (!logPath) return;
  appendFileSync(
    logPath,
    `${JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, event, ...details })}\n`,
    "utf-8",
  );
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, body, statusCode = 200) {
  const text = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

const args = process.argv.slice(2);
if (args[0] !== "serve") {
  console.error("mock-opencode only supports 'serve'");
  process.exit(1);
}

const host = args[args.indexOf("--hostname") + 1] ?? "127.0.0.1";
const port = Number(args[args.indexOf("--port") + 1] ?? "0");

let sessionCounter = 0;
const sessions = new Map();
const eventStreams = new Set();

function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const stream of eventStreams) {
    stream.write(line);
  }
}

function buildStructuredResponse(summary) {
  return {
    success: true,
    summary,
    key_changes_made: ["README.md"],
    key_learnings: ["mock opencode completed successfully"],
  };
}

function emitCompletedEvents(sessionId, summary) {
  const output = buildStructuredResponse(summary);
  broadcast({
    directory: "/repo",
    payload: {
      type: "message.part.updated",
      properties: {
        sessionID: sessionId,
        part: {
          id: "part-commentary",
          type: "text",
          text: "Mock agent is working.",
          metadata: { openai: { phase: "commentary" } },
        },
      },
    },
  });
  broadcast({
    directory: "/repo",
    payload: {
      type: "message.part.updated",
      properties: {
        sessionID: sessionId,
        part: {
          id: "part-final",
          type: "text",
          text: JSON.stringify(output),
          metadata: { openai: { phase: "final_answer" } },
        },
      },
    },
  });
  broadcast({
    directory: "/repo",
    payload: {
      type: "message.part.updated",
      properties: {
        sessionID: sessionId,
        part: {
          id: "finish-1",
          messageID: "msg-1",
          type: "step-finish",
          tokens: {
            input: 10,
            output: 5,
            cache: { read: 1, write: 0 },
          },
        },
      },
    },
  });
  broadcast({
    directory: "/repo",
    payload: {
      type: "session.idle",
      properties: { sessionID: sessionId },
    },
  });
  return output;
}

function applyWorkspaceChange(sessionId) {
  const session = sessions.get(sessionId);
  if (!session?.directory) return;

  const marker = `- mock change ${Date.now()}\n`;
  appendFileSync(join(session.directory, "README.md"), marker, "utf-8");
  appendLog("workspace:changed", { sessionId, marker: marker.trim() });
}

const server = createServer(async (req, res) => {
  appendLog("http:request", { method: req.method, url: req.url });

  if (req.method === "GET" && req.url === "/global/health") {
    sendJson(res, { healthy: true, version: "mock" });
    return;
  }

  if (req.method === "GET" && req.url === "/global/event") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.flushHeaders();
    eventStreams.add(res);
    req.on("close", () => {
      eventStreams.delete(res);
    });
    return;
  }

  if (req.method === "POST" && req.url === "/session") {
    const body = await readJson(req);
    const sessionId = `session-${++sessionCounter}`;
    sessions.set(sessionId, { directory: body.directory, aborted: false });
    appendLog("session:create", { sessionId, directory: body.directory });
    sendJson(res, { id: sessionId });
    return;
  }

  const match = req.url?.match(
    /^\/session\/([^/]+)(?:\/(message|prompt_async|abort))?$/,
  );
  if (match?.[2] === "message" && req.method === "POST") {
    const sessionId = match[1];
    const body = await readJson(req);
    const prompt = body.parts?.[0]?.text ?? "";
    appendLog("message:start", { sessionId, prompt });

    if (String(prompt).includes("slow cleanup")) {
      req.on("close", () => {
        appendLog("message:closed", { sessionId });
      });
      return;
    }

    applyWorkspaceChange(sessionId);
    const output = emitCompletedEvents(sessionId, "mocked objective complete");
    sendJson(res, {
      info: {
        id: "msg-1",
        role: "assistant",
        structured: output,
        tokens: {
          input: 10,
          output: 5,
          cache: { read: 1, write: 0 },
        },
      },
      parts: [
        {
          id: "part-final",
          type: "text",
          text: JSON.stringify(output),
          metadata: { openai: { phase: "final_answer" } },
        },
      ],
    });
    return;
  }

  if (match?.[2] === "prompt_async" && req.method === "POST") {
    const sessionId = match[1];
    const body = await readJson(req);
    const prompt = body.parts?.[0]?.text ?? "";
    appendLog("message:start", { sessionId, prompt });

    if (String(prompt).includes("slow cleanup")) {
      req.on("close", () => {
        appendLog("message:closed", { sessionId });
      });
      res.writeHead(204);
      res.end();
      return;
    }

    applyWorkspaceChange(sessionId);
    emitCompletedEvents(sessionId, "mocked objective complete");
    res.writeHead(204);
    res.end();
    return;
  }

  if (match?.[2] === "abort" && req.method === "POST") {
    const sessionId = match[1];
    const session = sessions.get(sessionId);
    if (session) session.aborted = true;
    appendLog("session:abort", { sessionId });
    sendJson(res, { ok: true });
    return;
  }

  if (match && !match[2] && req.method === "DELETE") {
    const sessionId = match[1];
    sessions.delete(sessionId);
    appendLog("session:delete", { sessionId });
    sendJson(res, { ok: true });
    return;
  }

  sendJson(res, { error: "not found" }, 404);
});

let shuttingDown = false;

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  appendLog("server:shutdown", { reason });
  for (const stream of eventStreams) {
    stream.end();
  }
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGBREAK", () => shutdown("SIGBREAK"));

server.listen(port, host, () => {
  appendLog("server:start", {
    command: "serve",
    host,
    port,
  });
});
