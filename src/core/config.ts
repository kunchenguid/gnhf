import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";

export const AGENT_NAMES = [
  "claude",
  "codex",
  "rovodev",
  "opencode",
  "copilot",
] as const;

export type AgentName = (typeof AGENT_NAMES)[number];

export interface Config {
  agent: AgentName;
  agentPathOverride: Partial<Record<AgentName, string>>;
  agentArgsOverride: Partial<Record<AgentName, string[]>>;
  maxConsecutiveFailures: number;
  preventSleep: boolean;
}

const DEFAULT_CONFIG: Config = {
  agent: "claude",
  agentPathOverride: {},
  agentArgsOverride: {},
  maxConsecutiveFailures: 3,
  preventSleep: true,
};

class InvalidConfigError extends Error {}

function formatAgentNameList(): string {
  const quoted = AGENT_NAMES.map((name) => `"${name}"`);
  return `${quoted.slice(0, -1).join(", ")}, or ${quoted[quoted.length - 1]}`;
}

function normalizePreventSleep(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;

  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "on") return true;
  if (value === "off") return false;
  return undefined;
}

function isReservedAgentArg(agent: AgentName, arg: string): boolean {
  switch (agent) {
    case "claude":
      return (
        arg === "-p" ||
        arg === "--print" ||
        arg === "--verbose" ||
        arg === "--output-format" ||
        arg.startsWith("--output-format=") ||
        arg === "--json-schema" ||
        arg.startsWith("--json-schema=")
      );
    case "codex":
      return (
        arg === "exec" ||
        arg === "--json" ||
        arg === "--output-schema" ||
        arg.startsWith("--output-schema=") ||
        arg === "--color" ||
        arg.startsWith("--color=")
      );
    case "opencode":
      return (
        arg === "serve" ||
        arg === "--hostname" ||
        arg.startsWith("--hostname=") ||
        arg === "--port" ||
        arg.startsWith("--port=") ||
        arg === "--print-logs"
      );
    case "rovodev":
      return (
        arg === "rovodev" ||
        arg === "serve" ||
        arg === "--disable-session-token"
      );
    case "copilot":
      return (
        arg === "-p" ||
        arg === "--prompt" ||
        arg.startsWith("--prompt=") ||
        arg === "-i" ||
        arg === "--interactive" ||
        arg.startsWith("--interactive=") ||
        arg === "-s" ||
        arg === "--silent" ||
        arg === "--output-format" ||
        arg.startsWith("--output-format=") ||
        arg === "--stream" ||
        arg.startsWith("--stream=") ||
        arg === "--no-color" ||
        arg === "--share" ||
        arg.startsWith("--share=") ||
        arg === "--share-gist"
      );
  }
}

/**
 * Resolve a user-supplied path against the config directory (~/.gnhf).
 * Expands leading `~` or `~/` to the home directory, then resolves relative
 * paths against `baseDir` so that entries like `./bin/codex` work predictably
 * regardless of the repo's cwd. Bare executable names and absolute paths pass
 * through unchanged.
 */
function resolveConfigPath(raw: string, baseDir: string): string {
  if (
    raw !== "~" &&
    !raw.startsWith("~/") &&
    !raw.startsWith("~\\") &&
    !raw.includes("/") &&
    !raw.includes("\\")
  ) {
    return raw;
  }

  const home = homedir();
  let expanded = raw;
  if (expanded === "~") {
    expanded = home;
  } else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = join(home, expanded.slice(2));
  }
  return resolve(baseDir, expanded);
}

function normalizeAgentPathOverride(
  value: unknown,
  configDir: string,
): Partial<Record<AgentName, string>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidConfigError(
      `Invalid config value for agentPathOverride: expected an object mapping agent names to paths`,
    );
  }

  const validNames = new Set<string>(AGENT_NAMES);
  const result: Partial<Record<AgentName, string>> = {};

  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (!validNames.has(key)) {
      throw new InvalidConfigError(
        `Invalid agent name in agentPathOverride: "${key}". Use ${formatAgentNameList()}.`,
      );
    }
    if (typeof val !== "string") {
      throw new InvalidConfigError(
        `Invalid path for agentPathOverride.${key}: expected a string`,
      );
    }
    if (val.trim() === "") {
      throw new InvalidConfigError(
        `Invalid path for agentPathOverride.${key}: expected a non-empty string`,
      );
    }
    result[key as AgentName] = resolveConfigPath(val, configDir);
  }

  return result;
}

function normalizeAgentExtraArgs(
  value: unknown,
  label: string,
  agent: AgentName,
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new InvalidConfigError(
      `Invalid config value for ${label}: expected an array of strings`,
    );
  }

  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new InvalidConfigError(
        `Invalid config value for ${label}[${index}]: expected a string`,
      );
    }

    const trimmed = entry.trim();
    if (trimmed === "") {
      throw new InvalidConfigError(
        `Invalid config value for ${label}[${index}]: expected a non-empty string`,
      );
    }

    if (isReservedAgentArg(agent, trimmed)) {
      throw new InvalidConfigError(
        `Invalid config value for ${label}[${index}]: "${trimmed}" is managed by gnhf and cannot be overridden`,
      );
    }

    return trimmed;
  });
}

function normalizeAgentArgsOverride(
  value: unknown,
): Partial<Record<AgentName, string[]>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidConfigError(
      `Invalid config value for agentArgsOverride: expected an object`,
    );
  }

  const validNames = new Set<string>(AGENT_NAMES);
  const result: Partial<Record<AgentName, string[]>> = {};

  for (const [key, rawConfig] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (!validNames.has(key)) {
      throw new InvalidConfigError(
        `Invalid agent name in agentArgsOverride: "${key}". Use ${formatAgentNameList()}.`,
      );
    }
    const args = normalizeAgentExtraArgs(
      rawConfig,
      `agentArgsOverride.${key}`,
      key as AgentName,
    );
    if (args !== undefined) {
      result[key as AgentName] = args;
    }
  }

  return Object.keys(result).length === 0 ? undefined : result;
}

function normalizeConfig(
  config: Partial<Config>,
  configDir?: string,
): Partial<Config> {
  const normalized: Partial<Config> = { ...config };
  const hasPreventSleep = Object.prototype.hasOwnProperty.call(
    config,
    "preventSleep",
  );
  const preventSleep = normalizePreventSleep(config.preventSleep);

  if (preventSleep === undefined) {
    if (hasPreventSleep && config.preventSleep !== undefined) {
      throw new InvalidConfigError(
        `Invalid config value for preventSleep: ${String(config.preventSleep)}`,
      );
    }
    delete normalized.preventSleep;
  } else {
    normalized.preventSleep = preventSleep;
  }

  const hasAgentPathOverride = Object.prototype.hasOwnProperty.call(
    config,
    "agentPathOverride",
  );
  if (hasAgentPathOverride) {
    const resolveDir = configDir ?? join(homedir(), ".gnhf");
    const agentPathOverride = normalizeAgentPathOverride(
      config.agentPathOverride,
      resolveDir,
    );
    if (agentPathOverride === undefined) {
      delete normalized.agentPathOverride;
    } else {
      normalized.agentPathOverride = agentPathOverride;
    }
  } else {
    delete normalized.agentPathOverride;
  }

  const hasAgentArgsOverride = Object.prototype.hasOwnProperty.call(
    config,
    "agentArgsOverride",
  );
  if (hasAgentArgsOverride) {
    const agentArgsOverride = normalizeAgentArgsOverride(
      config.agentArgsOverride,
    );
    if (agentArgsOverride === undefined) {
      delete normalized.agentArgsOverride;
    } else {
      normalized.agentArgsOverride = agentArgsOverride;
    }
  } else {
    delete normalized.agentArgsOverride;
  }

  return normalized;
}

function isMissingConfigError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return "code" in error
    ? error.code === "ENOENT"
    : error.message.includes("ENOENT");
}

function serializeAgentPathOverride(
  agentPathOverride: Partial<Record<AgentName, string>>,
): string {
  const serializedOverrides = Object.fromEntries(
    AGENT_NAMES.flatMap((name) => {
      const value = agentPathOverride[name];
      return value === undefined ? [] : [[name, value] as const];
    }),
  );

  if (Object.keys(serializedOverrides).length === 0) {
    return "";
  }

  return yaml
    .dump(
      { agentPathOverride: serializedOverrides },
      { lineWidth: -1, noRefs: true, sortKeys: false },
    )
    .trimEnd();
}

function serializeAgentArgsOverride(
  agentArgsOverride: Partial<Record<AgentName, string[]>>,
): string {
  if (Object.keys(agentArgsOverride).length === 0) {
    return "";
  }

  return yaml
    .dump(
      { agentArgsOverride },
      { lineWidth: -1, noRefs: true, sortKeys: false },
    )
    .trimEnd();
}

function serializeConfig(config: Config): string {
  const agentPathOverrideSection = serializeAgentPathOverride(
    config.agentPathOverride,
  );
  const agentArgsOverrideSection = serializeAgentArgsOverride(
    config.agentArgsOverride,
  );
  const lines = [
    "# Agent to use by default",
    `agent: ${config.agent}`,
    "",
    "# Custom paths to agent binaries (optional)",
    "# Paths may be absolute, bare executable names on PATH,",
    "# ~-prefixed, or relative to this config directory.",
    "# Note: rovodev overrides must point to an acli-compatible binary.",
    "# agentPathOverride:",
    "#   claude: /path/to/custom-claude",
    "#   codex: /path/to/custom-codex",
    "#   copilot: /path/to/custom-copilot",
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
  ];

  if (agentPathOverrideSection) {
    lines.push(...agentPathOverrideSection.split("\n"));
  }

  if (agentArgsOverrideSection) {
    lines.push(...agentArgsOverrideSection.split("\n"));
  }

  lines.push(
    "",
    "# Abort after this many consecutive failures",
    `maxConsecutiveFailures: ${config.maxConsecutiveFailures}`,
    "",
    "# Prevent the machine from sleeping during a run",
    `preventSleep: ${config.preventSleep}`,
    "",
  );

  return lines.join("\n");
}

export function loadConfig(overrides?: Partial<Config>): Config {
  const configDir = join(homedir(), ".gnhf");
  const configPath = join(configDir, "config.yml");
  let fileConfig: Partial<Config> = {};
  let shouldBootstrapConfig = false;

  try {
    const raw = readFileSync(configPath, "utf-8");
    fileConfig = normalizeConfig(
      (yaml.load(raw) as Partial<Config>) ?? {},
      configDir,
    );
  } catch (error) {
    if (error instanceof InvalidConfigError) {
      throw error;
    }
    if (isMissingConfigError(error)) {
      shouldBootstrapConfig = true;
    }

    // Config file doesn't exist or is invalid -- use defaults
  }

  const resolvedConfig = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...normalizeConfig(overrides ?? {}),
  };

  if (shouldBootstrapConfig) {
    try {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, serializeConfig(resolvedConfig), "utf-8");
    } catch {
      // Best-effort only. Startup should still fall back to in-memory defaults.
    }
  }

  return resolvedConfig;
}
