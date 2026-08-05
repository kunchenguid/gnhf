import { beforeEach, describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

import { execFileSync, spawn } from "node:child_process";
import { AntigravityAgent } from "./antigravity.js";

const mockSpawn = vi.mocked(spawn);

function createMockProcess() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: null,
    kill: vi.fn(),
  });
  return proc as typeof proc & ReturnType<typeof spawn>;
}

describe("AntigravityAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not use a shell for direct Windows launches", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new AntigravityAgent("/tmp/schema.json", {
      platform: "win32",
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "agy",
      [
        "--print",
        "test prompt",
        "--json-schema",
        "/tmp/schema.json",
        "--output-format",
        "stream-json",
      ],
      {
        cwd: "/work/dir",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );
  });

  it("uses a shell on Windows for cmd wrapper paths", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new AntigravityAgent("/tmp/schema.json", {
      bin: "C:\\tools\\antigravity.cmd",
      platform: "win32",
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "C:\\tools\\antigravity.cmd",
      [
        "--print",
        "test prompt",
        "--json-schema",
        "/tmp/schema.json",
        "--output-format",
        "stream-json",
      ],
      {
        cwd: "/work/dir",
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );
  });

  it("uses a shell on Windows when a bare override resolves to a cmd wrapper", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    vi.mocked(execFileSync).mockReturnValue(
      "C:\\tools\\antigravity-switch.cmd\r\n" as never,
    );
    const agent = new AntigravityAgent("/tmp/schema.json", {
      bin: "antigravity-switch",
      platform: "win32",
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "antigravity-switch",
      [
        "--print",
        "test prompt",
        "--json-schema",
        "/tmp/schema.json",
        "--output-format",
        "stream-json",
      ],
      {
        cwd: "/work/dir",
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );
  });

  it("passes configured extra args through to antigravity", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new AntigravityAgent("/tmp/schema.json", {
      extraArgs: ["--custom-arg", "value"],
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "agy",
      [
        "--custom-arg",
        "value",
        "--print",
        "test prompt",
        "--json-schema",
        "/tmp/schema.json",
        "--output-format",
        "stream-json",
      ],
      expect.any(Object),
    );
  });

  it("kills the full process tree on Windows when aborted", async () => {
    const proc = createMockProcess();
    Object.defineProperty(proc, "pid", { value: 6789 });
    mockSpawn.mockReturnValue(proc);
    const controller = new AbortController();
    const agent = new AntigravityAgent("/tmp/schema.json", {
      platform: "win32",
    });

    const promise = agent.run("test prompt", "/work/dir", {
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).rejects.toThrow("Agent was aborted");
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      "taskkill",
      ["/T", "/F", "/PID", "6789"],
      { stdio: "ignore" },
    );
    expect(proc.kill).not.toHaveBeenCalled();
  });
});
