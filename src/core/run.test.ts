import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";

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
import { setupRun, appendNotes, resumeRun, toStringArray } from "./run.js";

const P = "/project";

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
    setupRun("test-run-1", "fix bugs", "abc123", P, {
      includeStopField: false,
    });
    expect(mockMkdirSync).toHaveBeenCalledWith(join(P, ".git", "info"), {
      recursive: true,
    });
    expect(mockMkdirSync).toHaveBeenCalledWith(
      join(P, ".gnhf", "runs", "test-run-1"),
      { recursive: true },
    );
  });

  it("writes the ignore rule to .git/info/exclude", () => {
    setupRun("run-abc", "test", "abc123", P, { includeStopField: false });

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      join(P, ".git", "info", "exclude"),
      ".gnhf/runs/\n",
      "utf-8",
    );
  });

  it("writes PROMPT.md with the prompt text", () => {
    setupRun("run-abc", "improve coverage", "abc123", P, {
      includeStopField: false,
    });
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      join(P, ".gnhf", "runs", "run-abc", "prompt.md"),
      "improve coverage",
      "utf-8",
    );
  });

  it("writes notes.md with header and objective", () => {
    setupRun("run-abc", "improve coverage", "abc123", P, {
      includeStopField: false,
    });
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
    setupRun("run-abc", "test", "abc123", P, { includeStopField: false });
    const schemaCall = mockWriteFileSync.mock.calls.find(
      (call) =>
        typeof call[0] === "string" && call[0].endsWith("output-schema.json"),
    );
    expect(schemaCall).toBeDefined();
    const schema = JSON.parse(schemaCall![1] as string);
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toContain("success");
    expect(schema.required).toContain("summary");
    expect(schema.required).toContain("key_changes_made");
    expect(schema.required).toContain("key_learnings");
  });

  it("omits should_fully_stop from the schema when includeStopField is false", () => {
    setupRun("run-abc", "test", "abc123", P, { includeStopField: false });
    const schemaCall = mockWriteFileSync.mock.calls.find(
      (call) =>
        typeof call[0] === "string" && call[0].endsWith("output-schema.json"),
    );
    const schema = JSON.parse(schemaCall![1] as string);
    expect(schema.properties.should_fully_stop).toBeUndefined();
    expect(schema.required).not.toContain("should_fully_stop");
  });

  it("includes should_fully_stop in both properties and required when includeStopField is true", () => {
    setupRun("run-abc", "test", "abc123", P, { includeStopField: true });
    const schemaCall = mockWriteFileSync.mock.calls.find(
      (call) =>
        typeof call[0] === "string" && call[0].endsWith("output-schema.json"),
    );
    const schema = JSON.parse(schemaCall![1] as string);
    expect(schema.properties.should_fully_stop).toEqual({ type: "boolean" });
    expect(schema.required).toContain("should_fully_stop");
  });

  it("writes the branch base commit for new runs", () => {
    setupRun("run-abc", "test", "abc123", P, { includeStopField: false });

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      join(P, ".gnhf", "runs", "run-abc", "base-commit"),
      "abc123\n",
      "utf-8",
    );
  });

  it("preserves the existing branch base commit on overwrite", () => {
    const baseCommitPath = join(P, ".gnhf", "runs", "run-abc", "base-commit");
    mockExistsSync.mockImplementation((path) => path === baseCommitPath);
    mockReadFileSync.mockImplementation((path) =>
      path === baseCommitPath ? "old123\n" : "",
    );

    setupRun("run-abc", "test", "new456", P, { includeStopField: false });

    expect(mockWriteFileSync).not.toHaveBeenCalledWith(
      baseCommitPath,
      "new456\n",
      "utf-8",
    );
  });

  it("returns correct RunInfo paths", () => {
    const runDir = join(P, ".gnhf", "runs", "my-run");
    const info = setupRun("my-run", "prompt text", "abc123", P, {
      includeStopField: false,
    });
    expect(info).toEqual({
      runId: "my-run",
      runDir,
      promptPath: join(runDir, "prompt.md"),
      notesPath: join(runDir, "notes.md"),
      schemaPath: join(runDir, "output-schema.json"),
      logPath: join(runDir, "gnhf.log"),
      baseCommit: "abc123",
      baseCommitPath: join(runDir, "base-commit"),
    });
  });
});

describe("resumeRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refreshes output-schema.json to the current JSON schema", () => {
    const runDir = join(P, ".gnhf", "runs", "run-abc");
    mockExistsSync.mockImplementation((path) => path === runDir);

    resumeRun("run-abc", P, { includeStopField: false });

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      join(runDir, "output-schema.json"),
      expect.any(String),
      "utf-8",
    );
    const schemaCall = mockWriteFileSync.mock.calls.find(
      (call) =>
        typeof call[0] === "string" && call[0].endsWith("output-schema.json"),
    );
    const schema = JSON.parse(schemaCall![1] as string);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.should_fully_stop).toBeUndefined();
    expect(schema.required).not.toContain("should_fully_stop");
  });

  it("rewrites output-schema.json with should_fully_stop when includeStopField is true", () => {
    const runDir = join(P, ".gnhf", "runs", "run-abc");
    mockExistsSync.mockImplementation((path) => path === runDir);

    resumeRun("run-abc", P, { includeStopField: true });

    const schemaCall = mockWriteFileSync.mock.calls.find(
      (call) =>
        typeof call[0] === "string" && call[0].endsWith("output-schema.json"),
    );
    const schema = JSON.parse(schemaCall![1] as string);
    expect(schema.properties.should_fully_stop).toEqual({ type: "boolean" });
    expect(schema.required).toContain("should_fully_stop");
  });

  it("reads the stored base commit when present", () => {
    const runDir = join(P, ".gnhf", "runs", "run-abc");
    const baseCommitPath = join(runDir, "base-commit");
    mockExistsSync.mockImplementation(
      (path) => path === runDir || path === baseCommitPath,
    );
    mockReadFileSync.mockImplementation((path) =>
      path === baseCommitPath ? "abc123\n" : "",
    );

    const info = resumeRun("run-abc", P, { includeStopField: false });

    expect(info.baseCommit).toBe("abc123");
    expect(info.logPath).toBe(join(runDir, "gnhf.log"));
  });

  it("backfills missing base-commit for legacy runs", () => {
    const runDir = join(P, ".gnhf", "runs", "run-abc");
    mockExistsSync.mockImplementation((path) => path === runDir);
    mockFindLegacyRunBaseCommit.mockReturnValue("legacy123");

    const info = resumeRun("run-abc", P, { includeStopField: false });

    expect(mockFindLegacyRunBaseCommit).toHaveBeenCalledWith("run-abc", P);
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      join(runDir, "base-commit"),
      "legacy123\n",
      "utf-8",
    );
    expect(info.baseCommit).toBe("legacy123");
  });

  it("falls back to HEAD when a legacy run has no recoverable base commit", () => {
    const runDir = join(P, ".gnhf", "runs", "run-abc");
    mockExistsSync.mockImplementation((path) => path === runDir);
    mockFindLegacyRunBaseCommit.mockReturnValue(null);
    mockGetHeadCommit.mockReturnValue("head456");

    const info = resumeRun("run-abc", P, { includeStopField: false });

    expect(mockGetHeadCommit).toHaveBeenCalledWith(P);
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

describe("toStringArray", () => {
  it("returns a proper array of strings as-is", () => {
    expect(toStringArray(["a", "b"])).toEqual(["a", "b"]);
  });

  it("returns an empty array when input is an empty array", () => {
    expect(toStringArray([])).toEqual([]);
  });

  it("filters out non-string elements from a mixed array", () => {
    expect(toStringArray(["a", 2, null, "b"])).toEqual(["a", "b"]);
  });

  it("parses a JSON-stringified array back into strings", () => {
    expect(toStringArray('["a", "b"]')).toEqual(["a", "b"]);
  });

  it("returns the raw string as a single-element array when it is not valid JSON", () => {
    expect(toStringArray("not json")).toEqual(["not json"]);
  });

  it("returns an empty array for non-string, non-array primitives", () => {
    expect(toStringArray(123)).toEqual([]);
    expect(toStringArray(true)).toEqual([]);
  });

  it("returns an empty array for null", () => {
    expect(toStringArray(null)).toEqual([]);
  });
});
