#!/usr/bin/env node

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const tracesDir = join(fixtureDir, "acp-traces");

function appendLog(event, details = {}) {
  const logPath = process.env.MOCK_ACP_LOG_PATH;
  if (!logPath) return;
  appendFileSync(
    logPath,
    `${JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, event, ...details })}\n`,
    "utf-8",
  );
}

function readEnvNumber(name) {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function defaultStructuredOutput() {
  return {
    success: true,
    summary: "mock acp iteration",
    key_changes_made: ["README.md"],
    key_learnings: ["mock acp completed successfully"],
  };
}

function applyWorkspaceChange(cwd) {
  if (!cwd) return;
  const marker = `- mock acp change ${Date.now()}\n`;
  appendFileSync(join(cwd, "README.md"), marker, "utf-8");
  appendLog("workspace:changed", { cwd, marker: marker.trim() });
}

/**
 * Captured `AcpRuntimeEvent` (the runtime's normalized shape) does not
 * directly correspond to a `session/update` notification. The mock's job is
 * to re-emit each captured event as a wire-protocol notification that, when
 * normalized again by the real acpx runtime in gnhf, produces the same event
 * shape. Returns null for events the persona cannot meaningfully replay.
 */
function eventToSessionUpdate(event, sessionId, cwd) {
  if (event.type === "text_delta") {
    const stream = event.stream ?? "output";
    const tag =
      stream === "thought" ? "agent_thought_chunk" : "agent_message_chunk";
    const text = (event.text ?? "").replaceAll("<cwd>", cwd);
    return {
      sessionId,
      update: {
        sessionUpdate: tag,
        content: { type: "text", text },
      },
    };
  }
  if (event.type === "status" && event.tag === "usage_update") {
    if (typeof event.used !== "number" || typeof event.size !== "number") {
      return null;
    }
    return {
      sessionId,
      update: {
        sessionUpdate: "usage_update",
        used: event.used,
        size: event.size,
      },
    };
  }
  if (event.type === "tool_call") {
    // The tag tells us whether this was a fresh tool_call or an update.
    const sessionUpdate =
      event.tag === "tool_call_update" ? "tool_call_update" : "tool_call";
    const toolCallId = event.toolCallId ?? `mock-tool-${Date.now()}`;
    const update = {
      sessionUpdate,
      toolCallId,
      ...(event.status !== undefined && event.status !== null
        ? { status: event.status }
        : {}),
      ...(event.title !== undefined && event.title !== null
        ? { title: String(event.title).replaceAll("<cwd>", cwd) }
        : {}),
    };
    if (sessionUpdate === "tool_call") {
      // tool_call requires a `kind` per the schema; pick a permissive one.
      update.kind = "other";
    }
    return { sessionId, update };
  }
  return null;
}

class MockAcpAgent {
  constructor(connection) {
    this.connection = connection;
    this.sessions = new Map();
    this.iterationCounter = 0;
  }

  async initialize() {
    appendLog("agent:initialize");
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
    };
  }

  async authenticate() {
    return {};
  }

  async setSessionMode() {
    return {};
  }

  async newSession(params) {
    const sessionId = Array.from(randomBytes(16))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    this.sessions.set(sessionId, {
      cwd: params.cwd,
      pendingPrompt: null,
    });
    appendLog("agent:newSession", { sessionId, cwd: params.cwd });
    return { sessionId };
  }

  async cancel(params) {
    const session = this.sessions.get(params.sessionId);
    appendLog("agent:cancel", { sessionId: params.sessionId });
    session?.pendingPrompt?.abort();
  }

  async prompt(params) {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Session ${params.sessionId} not found`);

    this.iterationCounter += 1;
    const iteration = this.iterationCounter;
    appendLog("agent:prompt:start", {
      sessionId: params.sessionId,
      iteration,
    });

    session.pendingPrompt?.abort();
    const controller = new globalThis.AbortController();
    session.pendingPrompt = controller;

    const hangMs = readEnvNumber("MOCK_ACP_HANG_MS");
    if (hangMs && hangMs > 0) {
      try {
        await new Promise((resolveHang, reject) => {
          const timer = globalThis.setTimeout(resolveHang, hangMs);
          controller.signal.addEventListener("abort", () => {
            globalThis.clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
      } catch {
        appendLog("agent:prompt:cancelled", { iteration });
        return { stopReason: "cancelled" };
      }
    }

    const failMode = process.env.MOCK_ACP_FAIL;
    if (failMode === "throw") {
      appendLog("agent:prompt:throwing", { iteration });
      throw new Error("mock acp failure");
    }

    const persona = process.env.MOCK_ACP_PERSONA;
    if (persona) {
      await this.replayPersona(persona, params.sessionId, session.cwd);
    } else {
      await this.emitSyntheticOutput(params.sessionId, iteration);
    }

    applyWorkspaceChange(session.cwd);

    appendLog("agent:prompt:done", { iteration, persona: persona ?? null });
    session.pendingPrompt = null;
    return { stopReason: "end_turn" };
  }

  async replayPersona(persona, sessionId, cwd) {
    const tracePath = resolve(tracesDir, `${persona}.jsonl`);
    let traceContents;
    try {
      traceContents = readFileSync(tracePath, "utf-8");
    } catch (error) {
      throw new Error(
        `MOCK_ACP_PERSONA="${persona}" but trace file not found at ${tracePath}: ${error.message}`,
      );
    }
    const events = traceContents
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    appendLog("agent:persona:replay-start", {
      persona,
      eventCount: events.length,
    });

    let emitted = 0;
    for (const event of events) {
      const update = eventToSessionUpdate(event, sessionId, cwd);
      if (update === null) continue;
      await this.connection.sessionUpdate(update);
      emitted += 1;
    }

    appendLog("agent:persona:replay-done", { persona, emitted });
  }

  async emitSyntheticOutput(sessionId, iteration) {
    const usageUsed = readEnvNumber("MOCK_ACP_USAGE_USED");
    if (usageUsed !== undefined) {
      const cumulative = usageUsed * iteration;
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "usage_update",
          used: cumulative,
          size: 200000,
        },
      });
      appendLog("agent:prompt:usage", { iteration, used: cumulative });
    }

    const outputOverride = process.env.MOCK_ACP_OUTPUT_OVERRIDE;
    const structured = outputOverride
      ? JSON.parse(outputOverride)
      : defaultStructuredOutput();

    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: JSON.stringify(structured),
        },
      },
    });
  }
}

const stateFile = process.env.MOCK_ACP_STATE_FILE;
if (stateFile) {
  writeFileSync(
    stateFile,
    JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
    "utf-8",
  );
}

const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(process.stdin);
const stream = acp.ndJsonStream(output, input);
new acp.AgentSideConnection((conn) => new MockAcpAgent(conn), stream);
appendLog("process:ready");
