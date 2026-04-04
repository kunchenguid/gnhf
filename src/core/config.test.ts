import { describe, it, expect, vi, beforeEach } from "vitest";
import { join, resolve } from "node:path";

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

const HOME = "/mock-home";
const CONFIG_DIR = join(HOME, ".gnhf");
const CONFIG_PATH = join(CONFIG_DIR, "config.yml");

describe("loadConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns defaults when config file does not exist", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const config = loadConfig();

    expect(mockMkdirSync).toHaveBeenCalledWith(CONFIG_DIR, {
      recursive: true,
    });
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      CONFIG_PATH,
      "# Agent to use by default\nagent: claude\n\n# Custom paths to agent binaries (optional)\n# Paths may be absolute, bare executable names on PATH,\n# ~-prefixed, or relative to this config directory.\n# Note: rovodev overrides must point to an acli-compatible binary.\n# agentPathOverride:\n#   claude: /path/to/custom-claude\n#   codex: /path/to/custom-codex\n\n# Abort after this many consecutive failures\nmaxConsecutiveFailures: 3\n\n# Prevent the machine from sleeping during a run\npreventSleep: true\n",
      "utf-8",
    );
    expect(config).toEqual({
      agent: "claude",
      agentPathOverride: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
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
      agentPathOverride: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
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
      CONFIG_PATH,
      "# Agent to use by default\nagent: codex\n\n# Custom paths to agent binaries (optional)\n# Paths may be absolute, bare executable names on PATH,\n# ~-prefixed, or relative to this config directory.\n# Note: rovodev overrides must point to an acli-compatible binary.\n# agentPathOverride:\n#   claude: /path/to/custom-claude\n#   codex: /path/to/custom-codex\n\n# Abort after this many consecutive failures\nmaxConsecutiveFailures: 3\n\n# Prevent the machine from sleeping during a run\npreventSleep: true\n",
      "utf-8",
    );
    expect(config).toEqual({
      agent: "codex",
      agentPathOverride: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
    });
  });

  it("writes agentPathOverride values when bootstrapping a missing config file", () => {
    mockReadFileSync.mockImplementation(() => {
      const error = new Error("ENOENT");
      Object.assign(error, { code: "ENOENT" });
      throw error;
    });

    const config = loadConfig({
      agentPathOverride: {
        claude: "/usr/local/bin/claude-wrapper",
        codex: "./bin/codex-wrapper",
      },
    });

    const resolvedClaude = resolve("/usr/local/bin/claude-wrapper");
    const resolvedCodex = resolve(CONFIG_DIR, "bin", "codex-wrapper");

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      CONFIG_PATH,
      expect.stringContaining(`claude: ${resolvedClaude}`),
      "utf-8",
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      CONFIG_PATH,
      expect.stringContaining(`codex: ${resolvedCodex}`),
      "utf-8",
    );
    expect(config).toEqual({
      agent: "claude",
      agentPathOverride: {
        claude: resolvedClaude,
        codex: resolvedCodex,
      },
      maxConsecutiveFailures: 3,
      preventSleep: true,
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
      CONFIG_PATH,
      "# Agent to use by default\nagent: rovodev\n\n# Custom paths to agent binaries (optional)\n# Paths may be absolute, bare executable names on PATH,\n# ~-prefixed, or relative to this config directory.\n# Note: rovodev overrides must point to an acli-compatible binary.\n# agentPathOverride:\n#   claude: /path/to/custom-claude\n#   codex: /path/to/custom-codex\n\n# Abort after this many consecutive failures\nmaxConsecutiveFailures: 3\n\n# Prevent the machine from sleeping during a run\npreventSleep: true\n",
      "utf-8",
    );
    expect(config).toEqual({
      agent: "rovodev",
      agentPathOverride: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
    });
  });

  it("supports bootstrapping opencode as the configured agent", () => {
    mockReadFileSync.mockImplementation(() => {
      const error = new Error("ENOENT");
      Object.assign(error, { code: "ENOENT" });
      throw error;
    });

    const config = loadConfig({ agent: "opencode" });

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      CONFIG_PATH,
      "# Agent to use by default\nagent: opencode\n\n# Custom paths to agent binaries (optional)\n# Paths may be absolute, bare executable names on PATH,\n# ~-prefixed, or relative to this config directory.\n# Note: rovodev overrides must point to an acli-compatible binary.\n# agentPathOverride:\n#   claude: /path/to/custom-claude\n#   codex: /path/to/custom-codex\n\n# Abort after this many consecutive failures\nmaxConsecutiveFailures: 3\n\n# Prevent the machine from sleeping during a run\npreventSleep: true\n",
      "utf-8",
    );
    expect(config).toEqual({
      agent: "opencode",
      agentPathOverride: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
    });
  });

  it("reads config from ~/.gnhf/config.yml", () => {
    mockReadFileSync.mockReturnValue("agent: codex\n");

    const config = loadConfig();

    expect(mockReadFileSync).toHaveBeenCalledWith(CONFIG_PATH, "utf-8");
    expect(config.agent).toBe("codex");
  });

  it("merges file config with defaults", () => {
    mockReadFileSync.mockReturnValue("maxConsecutiveFailures: 10\n");

    const config = loadConfig();
    expect(config).toEqual({
      agent: "claude",
      agentPathOverride: {},
      maxConsecutiveFailures: 10,
      preventSleep: true,
    });
  });

  it('coerces quoted "false" for preventSleep to a boolean false', () => {
    mockReadFileSync.mockReturnValue('preventSleep: "false"\n');

    const config = loadConfig();

    expect(config).toEqual({
      agent: "claude",
      agentPathOverride: {},
      maxConsecutiveFailures: 3,
      preventSleep: false,
    });
  });

  it('coerces "off" for preventSleep to a boolean false', () => {
    mockReadFileSync.mockReturnValue("preventSleep: off\n");

    const config = loadConfig();

    expect(config).toEqual({
      agent: "claude",
      agentPathOverride: {},
      maxConsecutiveFailures: 3,
      preventSleep: false,
    });
  });

  it("throws when preventSleep has an unrecognized value", () => {
    mockReadFileSync.mockReturnValue("preventSleep: flase\n");

    expect(() => loadConfig()).toThrow(/Invalid config value for preventSleep/);
  });

  it("overrides take precedence over file config and defaults", () => {
    mockReadFileSync.mockReturnValue(
      "agent: codex\nmaxConsecutiveFailures: 10\npreventSleep: false\n",
    );

    const config = loadConfig({
      agent: "claude",
      agentPathOverride: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
    });
    expect(config).toEqual({
      agent: "claude",
      agentPathOverride: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
    });
  });

  it("handles empty config file gracefully", () => {
    mockReadFileSync.mockReturnValue("");

    const config = loadConfig();
    expect(config).toEqual({
      agent: "claude",
      agentPathOverride: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
    });
  });

  it("handles invalid YAML gracefully", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("invalid yaml");
    });

    const config = loadConfig();
    expect(config).toEqual({
      agent: "claude",
      agentPathOverride: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
    });
  });

  it("resolves ~ in agentPathOverride to the home directory", () => {
    mockReadFileSync.mockReturnValue(
      "agentPathOverride:\n  claude: ~/bin/my-claude\n",
    );

    const config = loadConfig();
    expect(config.agentPathOverride.claude).toBe(
      resolve(join(HOME, "bin", "my-claude")),
    );
  });

  it("resolves relative paths in agentPathOverride against the config directory", () => {
    mockReadFileSync.mockReturnValue(
      "agentPathOverride:\n  codex: ./bin/my-codex\n",
    );

    const config = loadConfig();
    expect(config.agentPathOverride.codex).toBe(
      resolve(CONFIG_DIR, "bin", "my-codex"),
    );
  });

  it("passes absolute paths in agentPathOverride through unchanged", () => {
    mockReadFileSync.mockReturnValue(
      "agentPathOverride:\n  claude: /usr/local/bin/my-claude\n",
    );

    const config = loadConfig();
    expect(config.agentPathOverride.claude).toBe(
      resolve("/usr/local/bin/my-claude"),
    );
  });

  it("preserves bare executable names in agentPathOverride", () => {
    mockReadFileSync.mockReturnValue(
      "agentPathOverride:\n  claude: claude-code-switch\n",
    );

    const config = loadConfig();

    expect(config.agentPathOverride.claude).toBe("claude-code-switch");
  });

  it("throws when agentPathOverride contains an unknown agent name", () => {
    mockReadFileSync.mockReturnValue("agentPathOverride:\n  unknown: /bin/x\n");

    expect(() => loadConfig()).toThrow(
      /Invalid agent name in agentPathOverride/,
    );
  });

  it("throws when agentPathOverride value is not a string", () => {
    mockReadFileSync.mockReturnValue("agentPathOverride:\n  claude: 42\n");

    expect(() => loadConfig()).toThrow(
      /Invalid path for agentPathOverride.claude/,
    );
  });

  it("throws when agentPathOverride value is blank", () => {
    mockReadFileSync.mockReturnValue('agentPathOverride:\n  claude: "   "\n');

    expect(() => loadConfig()).toThrow(
      /Invalid path for agentPathOverride.claude/,
    );
  });
});
