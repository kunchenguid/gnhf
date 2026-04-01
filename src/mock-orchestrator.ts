import { EventEmitter } from "node:events";
import type {
  OrchestratorState,
  OrchestratorEvents,
  IterationRecord,
} from "./core/orchestrator.js";

function mockIter(
  n: number,
  success: boolean,
  summary: string,
  agoMs: number,
): IterationRecord {
  return {
    number: n,
    success,
    summary,
    keyChanges: [],
    keyLearnings: [],
    timestamp: new Date(Date.now() - agoMs),
  };
}

const MOCK_ITERATIONS: IterationRecord[] = [
  mockIter(
    1,
    true,
    "Profiled cold start — identified 3 major bottlenecks",
    25_200_000,
  ),
  mockIter(
    2,
    true,
    "Lazy-loaded config module, shaved 340ms off init",
    24_000_000,
  ),
  mockIter(3, true, "Deferred plugin discovery to post-render", 22_800_000),
  mockIter(
    4,
    false,
    "Attempted parallel module init — race condition in DI container",
    21_000_000,
  ),
  mockIter(
    5,
    true,
    "Fixed DI ordering, parallelized safe modules only",
    19_200_000,
  ),
  mockIter(
    6,
    true,
    "Replaced synchronous JSON parse with streaming decoder",
    17_400_000,
  ),
  mockIter(
    7,
    true,
    "Cached resolved dependency graph across restarts",
    15_000_000,
  ),
  mockIter(
    8,
    false,
    "Tree-shaking broke runtime dynamic import paths",
    12_600_000,
  ),
  mockIter(
    9,
    true,
    "Restored dynamic imports, added explicit entry chunks",
    10_800_000,
  ),
  mockIter(
    10,
    true,
    "Inlined critical-path CSS, deferred non-essential styles",
    8_400_000,
  ),
  mockIter(
    11,
    true,
    "Switched from full Intl polyfill to locale-on-demand",
    6_000_000,
  ),
  mockIter(
    12,
    true,
    "Pre-compiled handlebars templates at build time",
    3_600_000,
  ),
  mockIter(
    13,
    true,
    "Moved telemetry init behind requestIdleCallback",
    1_800_000,
  ),
];

const AGENT_MESSAGES: string[] = [
  // ~1 line
  "Reading src/bootstrap.ts to trace the module init order",
  "Let me profile the require() chain with --cpu-prof",
  "Running integration tests after the lazy-load refactor",
  "Let me make sure HMR still works in dev mode",
  "Nice — startup dropped from 1.24s to 0.41s so far",
  // ~2 lines
  "Found it! There's a sync readFileSync in the config loader hot path — that's blocking the entire init sequence",
  "I'm analyzing the import graph for circular dependencies. So far I've found 3 cycles that force eager evaluation",
  "Now I'll move database pool creation behind a first-request gate so we don't pay the connection cost at boot time",
  "Let me check if the logger init can be deferred safely. It looks like only the error handler depends on it early",
  "Checking the bundle size delta after tree-shaking. Went from 847KB down to 612KB — solid improvement",
  "I'm replacing those sync fs calls with a pre-cached config lookup that gets populated during the build step",
  "Running a cold start benchmark to establish a baseline. Currently at 1.24s — I think we can get under 500ms",
  // ~3 lines
  "I'm looking at the startup flame graph and there are three clear bottlenecks: config parsing (310ms), plugin discovery (280ms), and template compilation (190ms)",
  "Let me verify the middleware registration order is still correct after the lazy-load refactor. The auth middleware needs to run before any route handlers get registered",
  "I need to test what happens when the first request arrives before deferred services finish initializing. Adding a readiness gate that blocks until all critical paths are up",
  "Now I'll investigate whether route registration can be made async without breaking the Express contract. The docs say app.listen() waits, but I want to confirm with a test",
  "Auditing all feature flags to see if any depend on early init. Looks like none of them do — they all read from a lazy-loaded remote config that we fetch on first access",
  "I'm adding startup timing spans to the OpenTelemetry traces so we can track cold start regressions in prod. Each phase will get its own span: config, plugins, routes, middleware",
  "Confirming all 47 tests still pass after these changes. The config loader tests needed updating since they were assuming synchronous initialization — fixing those now",
  "Let me validate the health check endpoint still responds within 50ms even during the deferred init window. I'll add a lightweight synthetic probe that skips the full stack",
];

// ── Randomization helpers ────────────────────────────────────

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── Mock orchestrator ────────────────────────────────────────

const INITIAL_ELAPSED_MS = 8 * 3_600_000 + 7 * 60_000 + 17_000; // 08:07:17

export class MockOrchestrator extends EventEmitter<OrchestratorEvents> {
  private state: OrchestratorState = {
    status: "running",
    currentIteration: 14,
    totalInputTokens: 87_300_000,
    totalOutputTokens: 860_000,
    commitCount: 11,
    iterations: [...MOCK_ITERATIONS],
    successCount: 11,
    failCount: 2,
    consecutiveFailures: 0,
    startTime: new Date(Date.now() - INITIAL_ELAPSED_MS),
    waitingUntil: null,
    lastMessage: AGENT_MESSAGES[0],
  };

  private tokenTimer: ReturnType<typeof setTimeout> | null = null;
  private messageTimer: ReturnType<typeof setTimeout> | null = null;
  private messageIndex = 0;

  getState(): OrchestratorState {
    return { ...this.state, iterations: [...this.state.iterations] };
  }

  stop(): void {
    if (this.tokenTimer) clearTimeout(this.tokenTimer);
    if (this.messageTimer) clearTimeout(this.messageTimer);
    this.tokenTimer = null;
    this.messageTimer = null;
    this.state.status = "stopped";
    this.emit("state", this.getState());
    this.emit("stopped");
  }

  start(): void {
    this.emit("state", this.getState());

    // Token counters: bump at slightly random intervals
    this.scheduleTokenBump();

    // Rotate agent message every 3-5 seconds
    this.scheduleNextMessage();
  }

  private scheduleTokenBump(): void {
    this.tokenTimer = setTimeout(
      () => {
        this.state.totalInputTokens += randInt(40_000, 180_000);
        this.state.totalOutputTokens += randInt(200, 2_000);
        this.emit("state", this.getState());
        if (this.state.status === "running") this.scheduleTokenBump();
      },
      randInt(1500, 7000),
    );
  }

  private scheduleNextMessage(): void {
    const delay = randInt(3000, 7000);
    this.messageTimer = setTimeout(() => {
      this.messageIndex = (this.messageIndex + 1) % AGENT_MESSAGES.length;
      this.state.lastMessage = AGENT_MESSAGES[this.messageIndex];
      this.emit("state", this.getState());
      this.scheduleNextMessage();
    }, delay);
  }
}
