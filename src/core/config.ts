import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";

export interface Config {
  agent: "claude" | "codex" | "rovodev" | "opencode";
  maxConsecutiveFailures: number;
  preventSleep: boolean;
}

const DEFAULT_CONFIG: Config = {
  agent: "claude",
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

function normalizeConfig(config: Partial<Config>): Partial<Config> {
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

  return normalized;
}

function isMissingConfigError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return "code" in error
    ? error.code === "ENOENT"
    : error.message.includes("ENOENT");
}

function serializeConfig(config: Config): string {
  return `# Agent to use by default
agent: ${config.agent}

# Abort after this many consecutive failures
maxConsecutiveFailures: ${config.maxConsecutiveFailures}

# Prevent the machine from sleeping during a run
preventSleep: ${config.preventSleep}
`;
}

export function loadConfig(overrides?: Partial<Config>): Config {
  const configDir = join(homedir(), ".gnhf");
  const configPath = join(configDir, "config.yml");
  let fileConfig: Partial<Config> = {};
  let shouldBootstrapConfig = false;

  try {
    const raw = readFileSync(configPath, "utf-8");
    fileConfig = normalizeConfig((yaml.load(raw) as Partial<Config>) ?? {});
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
