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
const BOOTSTRAP_CONFIG_TEMPLATE = (agent: string) =>
  [
    "# Agent to use by default",
    `agent: ${agent}`,
    "",
    "# Custom paths to agent binaries (optional)",
    "# Paths may be absolute, bare executable names on PATH,",
    "# ~-prefixed, or relative to this config directory.",
    "# Note: rovodev overrides must point to an acli-compatible binary.",
    "# agentPathOverride:",
    "#   claude: /path/to/custom-claude",
    "#   codex: /path/to/custom-codex",
    "#   copilot: /path/to/custom-copilot",
    "#   pi: /path/to/custom-pi",
    "",
    "# Per-agent CLI arg overrides (optional)",
    "# agentArgsOverride:",
    "#   codex:",
    "#     - -m",
    "#     - gpt-5.4",
    "#     - -c",
    '#     - model_reasoning_effort="high"',
    "#     - --full-auto",
    "#   copilot:",
    "#     - --model",
    "#     - gpt-5.4",
    "#   pi:",
    "#     - --provider",
    "#     - openai-codex",
    "#     - --model",
    "#     - gpt-5.5",
    "#     - --thinking",
    "#     - high",
    "",
    "# Commit message convention (optional)",
    "# Defaults to: gnhf #<iteration>: <summary>",
    "# Use Conventional Commits semantic-release headers:",
    "# commitMessage:",
    "#   preset: conventional",
    "",
    "# Abort after this many consecutive failures",
    "maxConsecutiveFailures: 3",
    "",
    "# Prevent the machine from sleeping during a run",
    "preventSleep: true",
    "",
  ].join("\n");

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
      BOOTSTRAP_CONFIG_TEMPLATE("claude"),
      "utf-8",
    );
    expect(config).toEqual({
      agent: "claude",
      agentPathOverride: {},
      agentArgsOverride: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
    });
    expect(config).not.toHaveProperty("commitMessage");
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
      agentArgsOverride: {},
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
      BOOTSTRAP_CONFIG_TEMPLATE("codex"),
      "utf-8",
    );
    expect(config).toEqual({
      agent: "codex",
      agentPathOverride: {},
      agentArgsOverride: {},
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
      agentArgsOverride: {},
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
      BOOTSTRAP_CONFIG_TEMPLATE("rovodev"),
      "utf-8",
    );
    expect(config).toEqual({
      agent: "rovodev",
      agentPathOverride: {},
      agentArgsOverride: {},
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
      BOOTSTRAP_CONFIG_TEMPLATE("opencode"),
      "utf-8",
    );
    expect(config).toEqual({
      agent: "opencode",
      agentPathOverride: {},
      agentArgsOverride: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
    });
  });

  it("supports bootstrapping copilot as the configured agent", () => {
    mockReadFileSync.mockImplementation(() => {
      const error = new Error("ENOENT");
      Object.assign(error, { code: "ENOENT" });
      throw error;
    });

    const config = loadConfig({ agent: "copilot" });

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      CONFIG_PATH,
      BOOTSTRAP_CONFIG_TEMPLATE("copilot"),
      "utf-8",
    );
    expect(config).toEqual({
      agent: "copilot",
      agentPathOverride: {},
      agentArgsOverride: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
    });
  });

  it("supports bootstrapping pi as the configured agent", () => {
    mockReadFileSync.mockImplementation(() => {
      const error = new Error("ENOENT");
      Object.assign(error, { code: "ENOENT" });
      throw error;
    });

    const config = loadConfig({ agent: "pi" });

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      CONFIG_PATH,
      BOOTSTRAP_CONFIG_TEMPLATE("pi"),
      "utf-8",
    );
    expect(config).toEqual({
      agent: "pi",
      agentPathOverride: {},
      agentArgsOverride: {},
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

  it("reads the conventional commit message preset from config", () => {
    mockReadFileSync.mockReturnValue(
      "commitMessage:\n  preset: conventional\n",
    );

    const config = loadConfig();

    expect(config.commitMessage).toEqual({
      preset: "conventional",
    });
  });

  it("throws when commitMessage omits a preset", () => {
    mockReadFileSync.mockReturnValue("commitMessage: {}\n");

    expect(() => loadConfig()).toThrow(
      /Invalid config value for commitMessage\.preset: expected "conventional"/,
    );
  });

  it("throws when commitMessage is present without a value", () => {
    mockReadFileSync.mockReturnValue("commitMessage:\n");

    expect(() => loadConfig()).toThrow(
      /Invalid config value for commitMessage: expected an object/,
    );
  });

  it("throws when commitMessage uses the gnhf preset explicitly", () => {
    mockReadFileSync.mockReturnValue("commitMessage:\n  preset: gnhf\n");

    expect(() => loadConfig()).toThrow(
      /Invalid config value for commitMessage\.preset: expected "conventional"/,
    );
  });

  it("throws when commitMessage uses the old angular preset", () => {
    mockReadFileSync.mockReturnValue("commitMessage:\n  preset: angular\n");

    expect(() => loadConfig()).toThrow(
      /Invalid config value for commitMessage\.preset: expected "conventional"/,
    );
  });

  it("throws when commitMessage includes a template", () => {
    mockReadFileSync.mockReturnValue(
      [
        "commitMessage:",
        "  preset: conventional",
        '  template: "{{type}}: {{summary}}"',
        "",
      ].join("\n"),
    );

    expect(() => loadConfig()).toThrow(
      /Unsupported config key for commitMessage\.template/,
    );
  });

  it("throws when commitMessage has an unknown preset", () => {
    mockReadFileSync.mockReturnValue("commitMessage:\n  preset: semantic\n");

    expect(() => loadConfig()).toThrow(
      /Invalid config value for commitMessage\.preset: expected "conventional"/,
    );
  });

  it("merges file config with defaults", () => {
    mockReadFileSync.mockReturnValue("maxConsecutiveFailures: 10\n");

    const config = loadConfig();
    expect(config).toEqual({
      agent: "claude",
      agentPathOverride: {},
      agentArgsOverride: {},
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
      agentArgsOverride: {},
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
      agentArgsOverride: {},
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
      agentArgsOverride: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
    });
    expect(config).toEqual({
      agent: "claude",
      agentPathOverride: {},
      agentArgsOverride: {},
      maxConsecutiveFailures: 3,
      preventSleep: true,
    });
  });

  it("reads per-agent extra args from config", () => {
    mockReadFileSync.mockReturnValue(
      "agentArgsOverride:\n  codex:\n    - -m\n    - gpt-5.4\n    - --full-auto\n",
    );

    const config = loadConfig();

    expect(config.agentArgsOverride).toEqual({
      codex: ["-m", "gpt-5.4", "--full-auto"],
    });
  });

  it("reads per-agent extra args for all supported agents", () => {
    mockReadFileSync.mockReturnValue(
      [
        "agentArgsOverride:",
        "  claude:",
        "    - --model",
        "    - sonnet",
        "  codex:",
        "    - -m",
        "    - gpt-5.4",
        "  rovodev:",
        "    - --profile",
        "    - work",
        "  opencode:",
        "    - --model",
        "    - gpt-5",
        "  copilot:",
        "    - --model",
        "    - gpt-5.4",
        "  pi:",
        "    - --provider",
        "    - openai-codex",
        "    - --model",
        "    - gpt-5.5",
        "    - --thinking",
        "    - high",
        "",
      ].join("\n"),
    );

    const config = loadConfig();

    expect(config.agentArgsOverride).toEqual({
      claude: ["--model", "sonnet"],
      codex: ["-m", "gpt-5.4"],
      rovodev: ["--profile", "work"],
      opencode: ["--model", "gpt-5"],
      copilot: ["--model", "gpt-5.4"],
      pi: [
        "--provider",
        "openai-codex",
        "--model",
        "gpt-5.5",
        "--thinking",
        "high",
      ],
    });
  });

  it("handles empty config file gracefully", () => {
    mockReadFileSync.mockReturnValue("");

    const config = loadConfig();
    expect(config).toEqual({
      agent: "claude",
      agentPathOverride: {},
      agentArgsOverride: {},
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
      agentArgsOverride: {},
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

  it("throws when agentArgsOverride contains an unknown agent name", () => {
    mockReadFileSync.mockReturnValue(
      "agentArgsOverride:\n  unknown:\n    - --flag\n",
    );

    expect(() => loadConfig()).toThrow(
      /Invalid agent name in agentArgsOverride/,
    );
  });

  it("throws when agentArgsOverride.codex is not an array", () => {
    mockReadFileSync.mockReturnValue(
      'agentArgsOverride:\n  codex: "--full-auto"\n',
    );

    expect(() => loadConfig()).toThrow(
      /Invalid config value for agentArgsOverride\.codex/,
    );
  });

  it("throws when agentArgsOverride.codex contains blank values", () => {
    mockReadFileSync.mockReturnValue(
      'agentArgsOverride:\n  codex:\n    - "   "\n',
    );

    expect(() => loadConfig()).toThrow(
      /Invalid config value for agentArgsOverride\.codex\[0\]/,
    );
  });

  it("throws when agentArgsOverride.codex contains gnhf-managed flags", () => {
    mockReadFileSync.mockReturnValue(
      "agentArgsOverride:\n  codex:\n    - --output-schema=custom.json\n",
    );

    expect(() => loadConfig()).toThrow(
      /agentArgsOverride\.codex\[0\].*managed by gnhf/,
    );
  });

  it("allows agentArgsOverride.claude to set the dangerous permission flag explicitly", () => {
    mockReadFileSync.mockReturnValue(
      "agentArgsOverride:\n  claude:\n    - --dangerously-skip-permissions\n",
    );

    const config = loadConfig();

    expect(config.agentArgsOverride).toEqual({
      claude: ["--dangerously-skip-permissions"],
    });
  });

  it("throws when agentArgsOverride.rovodev contains gnhf-managed flags", () => {
    mockReadFileSync.mockReturnValue(
      "agentArgsOverride:\n  rovodev:\n    - serve\n",
    );

    expect(() => loadConfig()).toThrow(
      /agentArgsOverride\.rovodev\[0\].*managed by gnhf/,
    );
  });

  it("throws when agentArgsOverride.copilot contains gnhf-managed flags", () => {
    mockReadFileSync.mockReturnValue(
      "agentArgsOverride:\n  copilot:\n    - --output-format=json\n",
    );

    expect(() => loadConfig()).toThrow(
      /agentArgsOverride\.copilot\[0\].*managed by gnhf/,
    );
  });

  it("allows safe agentArgsOverride.pi flags", () => {
    mockReadFileSync.mockReturnValue(
      "agentArgsOverride:\n  pi:\n    - --provider\n    - openai-codex\n    - --model\n    - gpt-5.5\n    - --thinking\n    - high\n",
    );

    const config = loadConfig();

    expect(config.agentArgsOverride).toEqual({
      pi: [
        "--provider",
        "openai-codex",
        "--model",
        "gpt-5.5",
        "--thinking",
        "high",
      ],
    });
  });

  it.each([
    "--mode",
    "--mode=json",
    "-p",
    "--session",
    "--no-session",
    "--api-key",
    "--api-key=secret",
  ])("throws when agentArgsOverride.pi contains reserved flag %s", (flag) => {
    mockReadFileSync.mockReturnValue(
      `agentArgsOverride:\n  pi:\n    - ${flag}\n`,
    );

    expect(() => loadConfig()).toThrow(
      /agentArgsOverride\.pi\[0\].*managed by gnhf/,
    );
  });
});
