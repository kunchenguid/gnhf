import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  createWriteStream: vi.fn(() => ({
    write: vi.fn(),
    end: vi.fn(),
  })),
}));

import { spawn } from "node:child_process";
import { TextBasedAgent } from "./text-based-agent.js";

const mockSpawn = vi.mocked(spawn);

class TestTextBasedAgent extends TextBasedAgent {
  name = "test-agent";

  protected buildArgs(prompt: string): string[] {
    return [prompt];
  }

  protected parseOutput(stdout: string) {
    return {
      success: true,
      summary: stdout.trim(),
      key_changes_made: [],
      key_learnings: [],
    };
  }

  protected parseUsage() {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
  }
}

function createMockProcess() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: null,
    kill: vi.fn(),
  });
  return proc as typeof proc & ReturnType<typeof spawn>;
}

describe("TextBasedAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it("does not time out after output has already started", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new TestTextBasedAgent("test-agent");

    const promise = agent.run("prompt", "/cwd");

    proc.stdout.emit("data", Buffer.from("still working\n"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(proc.kill).not.toHaveBeenCalled();

    proc.stdout.emit("data", Buffer.from("done\n"));
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: expect.objectContaining({ summary: "still working\ndone" }),
    });
  });
});
