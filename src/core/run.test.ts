import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  readFileSync: vi.fn(() => ""),
  readdirSync: vi.fn(() => []),
  existsSync: vi.fn(() => false),
  rmSync: vi.fn(),
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
import {
  setupRun,
  appendNotes,
  resumeRun,
  peekRunMetadata,
  toStringArray,
} from "./run.js";
import { CONVENTIONAL_COMMIT_MESSAGE } from "./commit-message.js";

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

  it("writes notes.md with header that points at prompt.md instead of inlining the prompt", () => {
    setupRun("run-abc", "improve coverage", "abc123", P, {
      includeStopField: false,
    });
    const notesCall = mockWriteFileSync.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].endsWith("notes.md"),
    );
    expect(notesCall).toBeDefined();
    const content = notesCall![1] as string;
    expect(content).toContain("# gnhf run: run-abc");
    expect(content).toContain(".gnhf/runs/run-abc/prompt.md");
    expect(content).not.toContain("improve coverage");
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

  it("writes configured commit message fields into output-schema.json", () => {
    setupRun("run-abc", "test", "abc123", P, {
      includeStopField: false,
      commitFields: [
        { name: "type", allowed: ["feat", "fix"] },
        { name: "scope" },
      ],
    });
    const schemaCall = mockWriteFileSync.mock.calls.find(
      (call) =>
        typeof call[0] === "string" && call[0].endsWith("output-schema.json"),
    );
    const schema = JSON.parse(schemaCall![1] as string);
    expect(schema.properties.type).toEqual({
      type: "string",
      enum: ["feat", "fix"],
    });
    expect(schema.properties.scope).toEqual({ type: "string" });
    expect(schema.required).toContain("type");
    expect(schema.required).toContain("scope");
  });

  it("writes the branch base commit for new runs", () => {
    setupRun("run-abc", "test", "abc123", P, { includeStopField: false });

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      join(P, ".gnhf", "runs", "run-abc", "base-commit"),
      "abc123\n",
      "utf-8",
    );
  });

  it("writes the stop-when file when provided", () => {
    setupRun("run-abc", "test", "abc123", P, {
      includeStopField: true,
      stopWhen: "all tests pass",
    });

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      join(P, ".gnhf", "runs", "run-abc", "stop-when"),
      "all tests pass\n",
      "utf-8",
    );
  });

  it("does not write the stop-when file when omitted", () => {
    setupRun("run-abc", "test", "abc123", P, { includeStopField: false });

    expect(mockWriteFileSync).not.toHaveBeenCalledWith(
      join(P, ".gnhf", "runs", "run-abc", "stop-when"),
      expect.any(String),
      "utf-8",
    );
  });

  it("writes default commit message metadata when commitMessage is omitted", () => {
    setupRun("run-abc", "test", "abc123", P, { includeStopField: false });

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      join(P, ".gnhf", "runs", "run-abc", "commit-message"),
      "default\n",
      "utf-8",
    );
  });

  it("writes conventional commit message metadata when configured", () => {
    setupRun("run-abc", "test", "abc123", P, {
      includeStopField: false,
      commitMessage: CONVENTIONAL_COMMIT_MESSAGE,
      commitFields: [
        { name: "type", allowed: ["feat", "fix"] },
        { name: "scope" },
      ],
    });

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      join(P, ".gnhf", "runs", "run-abc", "commit-message"),
      "conventional\n",
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

  it("preserves the existing notes.md on overwrite so prior iteration log survives", () => {
    const notesPath = join(P, ".gnhf", "runs", "run-abc", "notes.md");
    mockExistsSync.mockImplementation((path) => path === notesPath);

    setupRun("run-abc", "new prompt", "abc123", P, { includeStopField: false });

    const notesCall = mockWriteFileSync.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].endsWith("notes.md"),
    );
    expect(notesCall).toBeUndefined();
  });

  it("still overwrites prompt.md on overwrite so the new prompt takes effect", () => {
    const notesPath = join(P, ".gnhf", "runs", "run-abc", "notes.md");
    mockExistsSync.mockImplementation((path) => path === notesPath);

    setupRun("run-abc", "new prompt", "abc123", P, { includeStopField: false });

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      join(P, ".gnhf", "runs", "run-abc", "prompt.md"),
      "new prompt",
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
      stopWhenPath: join(runDir, "stop-when"),
      stopWhen: undefined,
      commitMessagePath: join(runDir, "commit-message"),
      commitMessage: undefined,
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

  it("reads the stored stop-when condition when present", () => {
    const runDir = join(P, ".gnhf", "runs", "run-abc");
    const stopWhenPath = join(runDir, "stop-when");
    mockExistsSync.mockImplementation(
      (path) => path === runDir || path === stopWhenPath,
    );
    mockReadFileSync.mockImplementation((path) =>
      path === stopWhenPath ? "all tests pass\n" : "",
    );

    const info = resumeRun("run-abc", P, { includeStopField: false });

    expect(info.stopWhen).toBe("all tests pass");
    expect(info.stopWhenPath).toBe(stopWhenPath);
  });

  it("returns undefined for stop-when when the file is missing", () => {
    const runDir = join(P, ".gnhf", "runs", "run-abc");
    mockExistsSync.mockImplementation((path) => path === runDir);

    const info = resumeRun("run-abc", P, { includeStopField: false });

    expect(info.stopWhen).toBeUndefined();
  });

  it("uses stored default commit message metadata on resume even when live config is conventional", () => {
    const runDir = join(P, ".gnhf", "runs", "run-abc");
    const commitMessagePath = join(runDir, "commit-message");
    mockExistsSync.mockImplementation(
      (path) => path === runDir || path === commitMessagePath,
    );
    mockReadFileSync.mockImplementation((path) =>
      path === commitMessagePath ? "default\n" : "",
    );

    const info = resumeRun("run-abc", P, {
      includeStopField: false,
      commitMessage: CONVENTIONAL_COMMIT_MESSAGE,
      commitFields: [
        { name: "type", allowed: ["feat", "fix"] },
        { name: "scope" },
      ],
    });

    expect(info.commitMessage).toBeUndefined();
    expect(info.commitMessagePath).toBe(commitMessagePath);
    const schemaCall = mockWriteFileSync.mock.calls.find(
      (call) =>
        typeof call[0] === "string" && call[0].endsWith("output-schema.json"),
    );
    const schema = JSON.parse(schemaCall![1] as string);
    expect(schema.properties.type).toBeUndefined();
    expect(schema.properties.scope).toBeUndefined();
  });

  it("uses stored conventional commit message metadata on resume even when live config is default", () => {
    const runDir = join(P, ".gnhf", "runs", "run-abc");
    const commitMessagePath = join(runDir, "commit-message");
    mockExistsSync.mockImplementation(
      (path) => path === runDir || path === commitMessagePath,
    );
    mockReadFileSync.mockImplementation((path) =>
      path === commitMessagePath ? "conventional\n" : "",
    );

    const info = resumeRun("run-abc", P, { includeStopField: false });

    expect(info.commitMessage).toEqual(CONVENTIONAL_COMMIT_MESSAGE);
    const schemaCall = mockWriteFileSync.mock.calls.find(
      (call) =>
        typeof call[0] === "string" && call[0].endsWith("output-schema.json"),
    );
    const schema = JSON.parse(schemaCall![1] as string);
    expect(schema.properties.type).toBeDefined();
    expect(schema.properties.scope).toBeDefined();
  });

  it("backfills missing commit message metadata from an existing conventional schema", () => {
    const runDir = join(P, ".gnhf", "runs", "run-abc");
    const schemaPath = join(runDir, "output-schema.json");
    const commitMessagePath = join(runDir, "commit-message");
    mockExistsSync.mockImplementation(
      (path) => path === runDir || path === schemaPath,
    );
    mockReadFileSync.mockImplementation((path) =>
      path === schemaPath
        ? JSON.stringify({
            properties: {
              type: { type: "string" },
              scope: { type: "string" },
            },
          })
        : "",
    );

    const info = resumeRun("run-abc", P, { includeStopField: false });

    expect(info.commitMessage).toEqual(CONVENTIONAL_COMMIT_MESSAGE);
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      commitMessagePath,
      "conventional\n",
      "utf-8",
    );
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

describe("peekRunMetadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads stored commit message metadata without writing files", () => {
    const runDir = join(P, ".gnhf", "runs", "run-abc");
    const commitMessagePath = join(runDir, "commit-message");
    mockExistsSync.mockImplementation(
      (path) => path === runDir || path === commitMessagePath,
    );
    mockReadFileSync.mockImplementation((path) =>
      path === commitMessagePath ? "conventional\n" : "",
    );

    const metadata = peekRunMetadata("run-abc", P);

    expect(metadata.promptPath).toBe(join(runDir, "prompt.md"));
    expect(metadata.commitMessage).toEqual(CONVENTIONAL_COMMIT_MESSAGE);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("infers legacy conventional metadata from the schema without backfilling", () => {
    const runDir = join(P, ".gnhf", "runs", "run-abc");
    const schemaPath = join(runDir, "output-schema.json");
    const commitMessagePath = join(runDir, "commit-message");
    mockExistsSync.mockImplementation(
      (path) => path === runDir || path === schemaPath,
    );
    mockReadFileSync.mockImplementation((path) =>
      path === schemaPath
        ? JSON.stringify({
            properties: {
              type: { type: "string" },
              scope: { type: "string" },
            },
          })
        : "",
    );

    const metadata = peekRunMetadata("run-abc", P);

    expect(metadata.commitMessagePath).toBe(commitMessagePath);
    expect(metadata.commitMessage).toEqual(CONVENTIONAL_COMMIT_MESSAGE);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("throws when the run directory is missing", () => {
    mockExistsSync.mockReturnValue(false);

    expect(() => peekRunMetadata("run-abc", P)).toThrow(
      "Run directory not found",
    );
    expect(mockWriteFileSync).not.toHaveBeenCalled();
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
