import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  readFileSync: vi.fn(() => ""),
  readdirSync: vi.fn(() => []),
  existsSync: vi.fn(() => false),
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ".git/info/exclude\n"),
}));

vi.mock("./git.js", () => ({
  findLegacyRunBaseCommit: vi.fn(() => null),
  getHeadCommit: vi.fn(() => "head123"),
}));

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { findLegacyRunBaseCommit, getHeadCommit } from "./git.js";
import { setupRun, appendNotes, resumeRun } from "./run.js";

const mockMkdirSync = vi.mocked(mkdirSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockAppendFileSync = vi.mocked(appendFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockExecFileSync = vi.mocked(execFileSync);
const mockFindLegacyRunBaseCommit = vi.mocked(findLegacyRunBaseCommit);
const mockGetHeadCommit = vi.mocked(getHeadCommit);

describe("setupRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockReturnValue(".git/info/exclude\n");
  });

  it("creates the run directory recursively", () => {
    setupRun("test-run-1", "fix bugs", "abc123", "/project");
    expect(mockMkdirSync).toHaveBeenCalledWith("/project/.git/info", {
      recursive: true,
    });
    expect(mockMkdirSync).toHaveBeenCalledWith(
      "/project/.gnhf/runs/test-run-1",
      { recursive: true },
    );
  });

  it("writes the ignore rule to .git/info/exclude", () => {
    setupRun("run-abc", "test", "abc123", "/project");

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/project/.git/info/exclude",
      ".gnhf/runs/\n",
      "utf-8",
    );
  });

  it("writes PROMPT.md with the prompt text", () => {
    setupRun("run-abc", "improve coverage", "abc123", "/project");
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/project/.gnhf/runs/run-abc/prompt.md",
      "improve coverage",
      "utf-8",
    );
  });

  it("writes notes.md with header and objective", () => {
    setupRun("run-abc", "improve coverage", "abc123", "/project");
    const notesCall = mockWriteFileSync.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].endsWith("notes.md"),
    );
    expect(notesCall).toBeDefined();
    const content = notesCall![1] as string;
    expect(content).toContain("# gnhf run: run-abc");
    expect(content).toContain("Objective: improve coverage");
    expect(content).toContain("## Iteration Log");
  });

  it("writes output-schema.json with valid JSON schema", () => {
    setupRun("run-abc", "test", "abc123", "/project");
    const schemaCall = mockWriteFileSync.mock.calls.find(
      (call) =>
        typeof call[0] === "string" && call[0].endsWith("output-schema.json"),
    );
    expect(schemaCall).toBeDefined();
    const schema = JSON.parse(schemaCall![1] as string);
    expect(schema.type).toBe("object");
    expect(schema.required).toContain("success");
    expect(schema.required).toContain("summary");
    expect(schema.required).toContain("key_changes_made");
    expect(schema.required).toContain("key_learnings");
  });

  it("writes the branch base commit for new runs", () => {
    setupRun("run-abc", "test", "abc123", "/project");

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/project/.gnhf/runs/run-abc/base-commit",
      "abc123\n",
      "utf-8",
    );
  });

  it("preserves the existing branch base commit on overwrite", () => {
    mockExistsSync.mockImplementation(
      (path) => path === "/project/.gnhf/runs/run-abc/base-commit",
    );
    mockReadFileSync.mockImplementation((path) =>
      path === "/project/.gnhf/runs/run-abc/base-commit" ? "old123\n" : "",
    );

    setupRun("run-abc", "test", "new456", "/project");

    expect(mockWriteFileSync).not.toHaveBeenCalledWith(
      "/project/.gnhf/runs/run-abc/base-commit",
      "new456\n",
      "utf-8",
    );
  });

  it("returns correct RunInfo paths", () => {
    const info = setupRun("my-run", "prompt text", "abc123", "/project");
    expect(info).toEqual({
      runId: "my-run",
      runDir: "/project/.gnhf/runs/my-run",
      promptPath: "/project/.gnhf/runs/my-run/prompt.md",
      notesPath: "/project/.gnhf/runs/my-run/notes.md",
      schemaPath: "/project/.gnhf/runs/my-run/output-schema.json",
      baseCommit: "abc123",
      baseCommitPath: "/project/.gnhf/runs/my-run/base-commit",
    });
  });
});

describe("resumeRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the stored base commit when present", () => {
    mockExistsSync.mockImplementation(
      (path) =>
        path === "/project/.gnhf/runs/run-abc" ||
        path === "/project/.gnhf/runs/run-abc/base-commit",
    );
    mockReadFileSync.mockImplementation((path) =>
      path === "/project/.gnhf/runs/run-abc/base-commit" ? "abc123\n" : "",
    );

    const info = resumeRun("run-abc", "/project");

    expect(info.baseCommit).toBe("abc123");
  });

  it("backfills missing base-commit for legacy runs", () => {
    mockExistsSync.mockImplementation(
      (path) => path === "/project/.gnhf/runs/run-abc",
    );
    mockFindLegacyRunBaseCommit.mockReturnValue("legacy123");

    const info = resumeRun("run-abc", "/project");

    expect(mockFindLegacyRunBaseCommit).toHaveBeenCalledWith(
      "run-abc",
      "/project",
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/project/.gnhf/runs/run-abc/base-commit",
      "legacy123\n",
      "utf-8",
    );
    expect(info.baseCommit).toBe("legacy123");
  });

  it("falls back to HEAD when a legacy run has no recoverable base commit", () => {
    mockExistsSync.mockImplementation(
      (path) => path === "/project/.gnhf/runs/run-abc",
    );
    mockFindLegacyRunBaseCommit.mockReturnValue(null);
    mockGetHeadCommit.mockReturnValue("head456");

    const info = resumeRun("run-abc", "/project");

    expect(mockGetHeadCommit).toHaveBeenCalledWith("/project");
    expect(info.baseCommit).toBe("head456");
  });
});

describe("appendNotes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("appends iteration header and summary", () => {
    appendNotes("/notes.md", 3, "Added tests", [], []);
    const content = mockAppendFileSync.mock.calls[0][1] as string;
    expect(content).toContain("### Iteration 3");
    expect(content).toContain("**Summary:** Added tests");
  });

  it("includes changes when provided", () => {
    appendNotes("/notes.md", 1, "summary", ["file1.ts", "file2.ts"], []);
    const content = mockAppendFileSync.mock.calls[0][1] as string;
    expect(content).toContain("**Changes:**");
    expect(content).toContain("- file1.ts");
    expect(content).toContain("- file2.ts");
  });

  it("includes learnings when provided", () => {
    appendNotes("/notes.md", 1, "summary", [], ["learned something"]);
    const content = mockAppendFileSync.mock.calls[0][1] as string;
    expect(content).toContain("**Learnings:**");
    expect(content).toContain("- learned something");
  });

  it("omits changes section when array is empty", () => {
    appendNotes("/notes.md", 1, "summary", [], ["learning"]);
    const content = mockAppendFileSync.mock.calls[0][1] as string;
    expect(content).not.toContain("**Changes:**");
  });

  it("omits learnings section when array is empty", () => {
    appendNotes("/notes.md", 1, "summary", ["change"], []);
    const content = mockAppendFileSync.mock.calls[0][1] as string;
    expect(content).not.toContain("**Learnings:**");
  });
});
