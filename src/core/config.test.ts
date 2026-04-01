import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/mock-home"),
}));

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "./config.js";

const mockMkdirSync = vi.mocked(mkdirSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

describe("loadConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns defaults when config file does not exist", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const config = loadConfig();

    expect(mockMkdirSync).toHaveBeenCalledWith("/mock-home/.gnhf", {
      recursive: true,
    });
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/mock-home/.gnhf/config.yml",
      "# Agent to use by default\nagent: claude\n\n# Abort after this many consecutive failures\nmaxConsecutiveFailures: 3\n",
      "utf-8",
    );
    expect(config).toEqual({
      agent: "claude",
      maxConsecutiveFailures: 3,
    });
  });

  it("still returns defaults when default config creation fails", () => {
    mockReadFileSync.mockImplementation(() => {
      const error = new Error("ENOENT");
      Object.assign(error, { code: "ENOENT" });
      throw error;
    });
    mockWriteFileSync.mockImplementation(() => {
      throw new Error("EPERM");
    });

    const config = loadConfig();

    expect(config).toEqual({
      agent: "claude",
      maxConsecutiveFailures: 3,
    });
  });

  it("writes override values when bootstrapping a missing config file", () => {
    mockReadFileSync.mockImplementation(() => {
      const error = new Error("ENOENT");
      Object.assign(error, { code: "ENOENT" });
      throw error;
    });

    const config = loadConfig({ agent: "codex" });

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/mock-home/.gnhf/config.yml",
      "# Agent to use by default\nagent: codex\n\n# Abort after this many consecutive failures\nmaxConsecutiveFailures: 3\n",
      "utf-8",
    );
    expect(config).toEqual({
      agent: "codex",
      maxConsecutiveFailures: 3,
    });
  });

  it("supports bootstrapping rovodev as the configured agent", () => {
    mockReadFileSync.mockImplementation(() => {
      const error = new Error("ENOENT");
      Object.assign(error, { code: "ENOENT" });
      throw error;
    });

    const config = loadConfig({ agent: "rovodev" });

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/mock-home/.gnhf/config.yml",
      "# Agent to use by default\nagent: rovodev\n\n# Abort after this many consecutive failures\nmaxConsecutiveFailures: 3\n",
      "utf-8",
    );
    expect(config).toEqual({
      agent: "rovodev",
      maxConsecutiveFailures: 3,
    });
  });

  it("reads config from ~/.gnhf/config.yml", () => {
    mockReadFileSync.mockReturnValue("agent: codex\n");

    const config = loadConfig();

    expect(mockReadFileSync).toHaveBeenCalledWith(
      "/mock-home/.gnhf/config.yml",
      "utf-8",
    );
    expect(config.agent).toBe("codex");
  });

  it("merges file config with defaults", () => {
    mockReadFileSync.mockReturnValue("maxConsecutiveFailures: 10\n");

    const config = loadConfig();
    expect(config).toEqual({
      agent: "claude",
      maxConsecutiveFailures: 10,
    });
  });

  it("overrides take precedence over file config and defaults", () => {
    mockReadFileSync.mockReturnValue(
      "agent: codex\nmaxConsecutiveFailures: 10\n",
    );

    const config = loadConfig({ agent: "claude", maxConsecutiveFailures: 3 });
    expect(config).toEqual({
      agent: "claude",
      maxConsecutiveFailures: 3,
    });
  });

  it("handles empty config file gracefully", () => {
    mockReadFileSync.mockReturnValue("");

    const config = loadConfig();
    expect(config).toEqual({
      agent: "claude",
      maxConsecutiveFailures: 3,
    });
  });

  it("handles invalid YAML gracefully", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("invalid yaml");
    });

    const config = loadConfig();
    expect(config).toEqual({
      agent: "claude",
      maxConsecutiveFailures: 3,
    });
  });
});
