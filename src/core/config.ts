import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";

export type AgentName = "claude" | "codex" | "rovodev" | "opencode";

const AGENT_NAMES = ["claude", "codex", "rovodev", "opencode"] as const;

export interface Config {
  agent: AgentName;
  agentPathOverride: Partial<Record<AgentName, string>>;
  maxConsecutiveFailures: number;
  preventSleep: boolean;
}

const DEFAULT_CONFIG: Config = {
  agent: "claude",
  agentPathOverride: {},
  maxConsecutiveFailures: 3,
  preventSleep: true,
};

class InvalidConfigError extends Error {}

function normalizePreventSleep(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;

  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "on") return true;
  if (value === "off") return false;
  return undefined;
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
        `Invalid agent name in agentPathOverride: "${key}". Use "claude", "codex", "rovodev", or "opencode".`,
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

function serializeConfig(config: Config): string {
  const agentPathOverrideSection = serializeAgentPathOverride(
    config.agentPathOverride,
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
  ];

  if (agentPathOverrideSection) {
    lines.push(...agentPathOverrideSection.split("\n"));
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
