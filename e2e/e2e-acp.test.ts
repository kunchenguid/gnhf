import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mockAgentCommand } from "acp-mock";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distCliPath = join(repoRoot, "dist", "cli.mjs");
const acpMockBinPath = join(
  repoRoot,
  "node_modules",
  "acp-mock",
  "dist",
  "cli.js",
);
const acpTracesDir = join(repoRoot, "e2e", "fixtures", "acp-traces");

const defaultMockOutput = {
  success: true,
  summary: "mock acp iteration",
  key_changes_made: ["README.md"],
  key_learnings: ["mock acp completed successfully"],
};

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function createRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "gnhf-e2e-acp-"));
  git(["init", "-b", "main"], cwd);
  git(["config", "user.name", "gnhf tests"], cwd);
  git(["config", "user.email", "tests@example.com"], cwd);
  writeFileSync(join(cwd, "README.md"), "# fixture\n", "utf-8");
  git(["add", "README.md"], cwd);
  git(["commit", "-m", "init"], cwd);
  return cwd;
}

function readJsonLines(filePath: string): Record<string, unknown>[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function findRunLogPath(cwd: string): string {
  const runsDir = join(cwd, ".gnhf", "runs");
  const runs = readdirSync(runsDir);
  if (runs.length !== 1) {
    throw new Error(
      `Expected exactly one run in ${runsDir}, found ${runs.length}`,
    );
  }
  return join(runsDir, runs[0]!, "gnhf.log");
}

async function waitForLogEvent(
  filePath: string,
  event: string,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = readJsonLines(filePath).find(
      (entry) => entry.event === event,
    );
    if (match) return match;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Timed out waiting for log event ${event} in ${filePath}`);
}

function buildMockTargetCommand(options: {
  eventLogPath: string;
  runtimeEventsPath?: string;
  usageUpdateUsed?: number;
  usageUpdateMode?: "static" | "cumulative";
  toolCallCount?: number;
  promptDelayMs?: number;
}): string {
  return mockAgentCommand({
    bin: acpMockBinPath,
    eventLogPath: options.eventLogPath,
    runtimeEventsPath: options.runtimeEventsPath,
    agentMessageJson: defaultMockOutput,
    usageUpdateUsed: options.usageUpdateUsed,
    usageUpdateMode: options.usageUpdateMode,
    toolCallCount: options.toolCallCount,
    promptDelayMs: options.promptDelayMs,
    appendFile: {
      path: "README.md",
      text: `- mock acp change ${Date.now()}\n`,
    },
  });
}

function setupAcpHome(
  tempDirs: string[],
  mockCommand: string,
): {
  home: string;
  configPath: string;
} {
  const home = mkdtempSync(join(tmpdir(), "gnhf-e2e-acp-home-"));
  tempDirs.push(home);
  mkdirSync(join(home, ".gnhf"), { recursive: true });
  const configPath = join(home, ".gnhf", "config.yml");
  writeFileSync(
    configPath,
    [
      "acpRegistryOverrides:",
      `  mock-target: ${JSON.stringify(mockCommand)}`,
      "",
    ].join("\n"),
    "utf-8",
  );
  return { home, configPath };
}

function buildEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
  };
}

function runCli(
  cwd: string,
  args: string[],
  options: { stdin?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [distCliPath, ...args], {
      cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolveResult({ code, signal, stdout, stderr });
    });
    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}

describe("gnhf acp e2e", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 200,
        });
      } catch {
        // Windows: child processes may briefly hold file locks after exit
      }
    }
  });

  // Real-adapter persona tests. Each persona replays a recorded trace captured
  // from a real ACP adapter (Claude Code, Codex, OpenCode) via the bundled acpx
  // runtime, so the wire shape gnhf has to consume exactly matches what real
  // adapters emit:
  //   - claude: 7 medium agent_message_chunk text_deltas, prose+JSON in one
  //     continuous stream, ~25 interleaved tool_call/usage_update events
  //   - codex: 174 tiny text_deltas (1-15 chars each), prose+JSON in one stream
  //   - opencode: 30 chunks, JSON-only wrapped in ```json fences
  // Captured under e2e/fixtures/acp-traces/.
  it.skipIf(process.platform === "win32").each(["claude", "codex", "opencode"])(
    "produces a successful commit for the %s persona",
    async (persona) => {
      const cwd = createRepo();
      tempDirs.push(cwd);
      const logDir = mkdtempSync(join(tmpdir(), "gnhf-e2e-acp-logs-"));
      tempDirs.push(logDir);
      const mockLogPath = join(logDir, "mock-acp.jsonl");
      const { home } = setupAcpHome(
        tempDirs,
        buildMockTargetCommand({
          eventLogPath: mockLogPath,
          runtimeEventsPath: join(acpTracesDir, `${persona}.jsonl`),
        }),
      );

      const result = await runCli(
        cwd,
        ["ship it", "--agent", "acp:mock-target", "--max-iterations", "1"],
        {
          env: buildEnv(home),
        },
      );

      expect(result.code).toBe(0);
      // init commit + 1 iteration commit. If the parser fails on real-shaped
      // output, no iteration commit lands and this is "1".
      expect(git(["rev-list", "--count", "HEAD"], cwd)).toBe("2");

      const debugEntries = readJsonLines(findRunLogPath(cwd));
      const iterationEnd = debugEntries.find(
        (e) => e.event === "iteration:end",
      );
      expect(iterationEnd?.success).toBe(true);

      // Persona traces include usage_update events. The agent must surface a
      // non-zero input token count by iteration end - either from the
      // recorded `used` deltas or, if those are zero/absent, from a fallback
      // estimate. Catches the bug where `inputTokens` is hardcoded to the
      // raw `used` delta and stays at 0 for adapters that never emit usage.
      expect(Number(iterationEnd?.totalInputTokens)).toBeGreaterThan(0);
      // Output tokens are estimated from streamed text_delta chars across
      // both `output` and `thought` streams. The opencode persona in
      // particular streams ~70% of its text on the thought stream, so this
      // catches the regression where only `output`-stream chars were
      // counted and reasoning-heavy adapters sat at 0.
      expect(Number(iterationEnd?.totalOutputTokens)).toBeGreaterThan(0);
    },
    45_000,
  );

  it.skipIf(process.platform === "win32")(
    "runs one iteration against an ACP target registered via acpRegistryOverrides",
    async () => {
      const cwd = createRepo();
      tempDirs.push(cwd);
      const logDir = mkdtempSync(join(tmpdir(), "gnhf-e2e-acp-logs-"));
      tempDirs.push(logDir);
      const mockLogPath = join(logDir, "mock-acp.jsonl");
      const { home } = setupAcpHome(
        tempDirs,
        buildMockTargetCommand({ eventLogPath: mockLogPath }),
      );

      const result = await runCli(
        cwd,
        ["ship it", "--agent", "acp:mock-target", "--max-iterations", "1"],
        { env: buildEnv(home) },
      );

      expect(result.code).toBe(0);
      expect(git(["rev-list", "--count", "HEAD"], cwd)).toBe("2");
      expect(git(["log", "-1", "--format=%s"], cwd)).toContain("gnhf 1:");

      const mockEvents = readJsonLines(mockLogPath).map((e) => e.event);
      expect(mockEvents).toContain("agent:initialize");
      expect(mockEvents).toContain("agent:newSession");
      expect(mockEvents).toContain("agent:prompt:start");
      expect(mockEvents).toContain("agent:prompt:done");
      expect(mockEvents).toContain("workspace:changed");

      const debugEvents = readJsonLines(findRunLogPath(cwd)).map(
        (e) => e.event,
      );
      expect(debugEvents).toContain("acp:runtime:created");
      expect(debugEvents).toContain("acp:turn:start");
      expect(debugEvents).toContain("acp:turn:result");
      expect(debugEvents).toContain("acp:close");
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "runs one iteration against a raw ACP command spec",
    async () => {
      const cwd = createRepo();
      tempDirs.push(cwd);
      const logDir = mkdtempSync(join(tmpdir(), "gnhf-e2e-acp-logs-"));
      tempDirs.push(logDir);
      const mockLogPath = join(logDir, "mock-acp.jsonl");
      const rawAgentCommand = buildMockTargetCommand({
        eventLogPath: mockLogPath,
      });
      const { home } = setupAcpHome(tempDirs, rawAgentCommand);
      const rawAgentSpec = `acp:${rawAgentCommand}`;

      const result = await runCli(
        cwd,
        ["ship it", "--agent", rawAgentSpec, "--max-iterations", "1"],
        { env: buildEnv(home) },
      );

      expect(result.code).toBe(0);
      expect(git(["rev-list", "--count", "HEAD"], cwd)).toBe("2");

      const mockEvents = readJsonLines(mockLogPath).map((e) => e.event);
      expect(mockEvents).toContain("agent:initialize");
      expect(mockEvents).toContain("agent:prompt:done");

      const debugLog = readFileSync(findRunLogPath(cwd), "utf-8");
      expect(debugLog).toContain('"agent":"acp:custom"');
      expect(debugLog).toContain('"target":"custom"');
      expect(debugLog).not.toContain(rawAgentSpec);
      expect(debugLog).not.toContain(rawAgentCommand);
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "reuses the persistent ACP session across multiple iterations and reports per-iteration usage deltas",
    async () => {
      const cwd = createRepo();
      tempDirs.push(cwd);
      const logDir = mkdtempSync(join(tmpdir(), "gnhf-e2e-acp-logs-"));
      tempDirs.push(logDir);
      const mockLogPath = join(logDir, "mock-acp.jsonl");
      const { home } = setupAcpHome(
        tempDirs,
        buildMockTargetCommand({
          eventLogPath: mockLogPath,
          usageUpdateUsed: 100,
          usageUpdateMode: "cumulative",
        }),
      );

      const result = await runCli(
        cwd,
        ["ship it", "--agent", "acp:mock-target", "--max-iterations", "3"],
        { env: buildEnv(home) },
      );

      expect(result.code).toBe(0);
      expect(git(["rev-list", "--count", "HEAD"], cwd)).toBe("4"); // init + 3 iterations

      const mockEntries = readJsonLines(mockLogPath);
      const newSessionCount = mockEntries.filter(
        (e) => e.event === "agent:newSession",
      ).length;
      const promptStartCount = mockEntries.filter(
        (e) => e.event === "agent:prompt:start",
      ).length;
      // Persistent session: only one newSession across iterations.
      expect(newSessionCount).toBe(1);
      expect(promptStartCount).toBe(3);

      // Mock emits cumulative usage = 100, 200, 300 across iterations. gnhf
      // should compute per-iteration deltas of 100 each, so total input
      // tokens after 3 iterations = 300.
      const usageEvents = mockEntries.filter(
        (e) => e.event === "agent:prompt:usage",
      );
      expect(usageEvents.map((e) => e.used)).toEqual([100, 200, 300]);

      const debugEntries = readJsonLines(findRunLogPath(cwd));
      const turnResults = debugEntries.filter(
        (e) => e.event === "acp:turn:result",
      );
      expect(turnResults.length).toBe(3);

      // When usage_update is reported by the adapter, the totals are
      // authoritative - tokensEstimated stays false so the renderer omits
      // the "~" prefix.
      const iterationEnds = debugEntries.filter(
        (e) => e.event === "iteration:end",
      );
      const lastEnd = iterationEnds[iterationEnds.length - 1]!;
      expect(lastEnd.tokensEstimated).toBe(false);
      expect(lastEnd.totalInputTokens).toBe(300);
    },
    45_000,
  );

  it.skipIf(process.platform === "win32")(
    "marks tokens as estimated and scales input with tool-call count when no usage_update fires",
    async () => {
      // Regression: ACP adapters that never emit usage_update (Pi, some
      // others) used to fall back to a prompt-length-only estimate that
      // ignored tool-call payloads, so a run with hundreds of tool calls per
      // iteration would still report ~700 input tokens/iteration. The fix:
      // count distinct tool_call events as input cost, and flag the totals
      // as estimated so the renderer can show "~". This test exercises both.
      const cwd = createRepo();
      tempDirs.push(cwd);
      const logDir = mkdtempSync(join(tmpdir(), "gnhf-e2e-acp-logs-"));
      tempDirs.push(logDir);
      const mockLogPath = join(logDir, "mock-acp.jsonl");
      const { home } = setupAcpHome(
        tempDirs,
        buildMockTargetCommand({
          eventLogPath: mockLogPath,
          toolCallCount: 5,
        }),
      );

      // No usage_update flag -> no usage_update events emitted. 5 tool
      // calls per iteration × 2 iterations = 10 distinct tool calls feeding
      // the heuristic.
      const result = await runCli(
        cwd,
        ["ship it", "--agent", "acp:mock-target", "--max-iterations", "2"],
        { env: buildEnv(home) },
      );

      expect(result.code).toBe(0);

      const mockEntries = readJsonLines(mockLogPath);
      const usageEvents = mockEntries.filter(
        (e) => e.event === "agent:prompt:usage",
      );
      expect(usageEvents).toHaveLength(0);
      const toolCallEvents = mockEntries.filter(
        (e) => e.event === "agent:prompt:tool-calls",
      );
      expect(toolCallEvents.map((e) => e.count)).toEqual([5, 5]);

      const debugEntries = readJsonLines(findRunLogPath(cwd));
      const iterationEnds = debugEntries.filter(
        (e) => e.event === "iteration:end",
      );
      expect(iterationEnds).toHaveLength(2);

      // Without usage_update events, the totals are heuristic and the
      // orchestrator's sticky tokensEstimated flag must be set so the
      // renderer can prefix "~".
      const lastEnd = iterationEnds[iterationEnds.length - 1]!;
      expect(lastEnd.tokensEstimated).toBe(true);

      // Each tool call adds ~2K to the input estimate. 10 tool calls means
      // total input must be at least 20K - way above the prompt-only floor
      // (which would be a few hundred tokens). This is the assertion that
      // would have caught the original under-counting bug.
      expect(Number(lastEnd.totalInputTokens)).toBeGreaterThan(20_000);
    },
    45_000,
  );

  it.skipIf(process.platform === "win32")(
    "cancels the in-flight ACP turn on SIGINT and shuts down cleanly",
    async () => {
      const cwd = createRepo();
      tempDirs.push(cwd);
      const logDir = mkdtempSync(join(tmpdir(), "gnhf-e2e-acp-logs-"));
      tempDirs.push(logDir);
      const mockLogPath = join(logDir, "mock-acp.jsonl");
      const { home } = setupAcpHome(
        tempDirs,
        buildMockTargetCommand({
          eventLogPath: mockLogPath,
          promptDelayMs: 30_000,
        }),
      );

      const child = spawn(
        process.execPath,
        [distCliPath, "ship it", "--agent", "acp:mock-target"],
        {
          cwd,
          env: buildEnv(home),
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      child.stdin.end();

      const exitPromise = new Promise<RunResult>((resolveResult, reject) => {
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", (code, signal) => {
          resolveResult({ code, signal, stdout, stderr });
        });
      });

      await waitForLogEvent(mockLogPath, "agent:prompt:start");
      child.kill("SIGINT");
      await new Promise((r) => setTimeout(r, 50));
      child.kill("SIGINT");

      const result = await exitPromise;
      expect(result.code).toBe(130);

      const debugEntries = readJsonLines(findRunLogPath(cwd));
      const debugEvents = debugEntries.map((e) => e.event);
      expect(debugEvents).toContain("acp:turn:start");
      expect(debugEvents).toContain("signal:SIGINT");
      expect(debugEvents).toContain("acp:close");
      // The turn must end via cancellation, either through the streaming
      // abort path (acp:turn:aborted) or by the runtime returning a cancelled
      // result after the agent close interrupts the in-flight prompt.
      const turnEnded =
        debugEvents.includes("acp:turn:aborted") ||
        debugEntries.some(
          (e) => e.event === "acp:turn:result" && e.status === "cancelled",
        );
      expect(turnEnded).toBe(true);
    },
    30_000,
  );
});
