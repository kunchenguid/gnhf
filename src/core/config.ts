import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";

export interface Config {
  agent: "claude" | "codex" | "rovodev";
  maxConsecutiveFailures: number;
}

const DEFAULT_CONFIG: Config = {
  agent: "claude",
  maxConsecutiveFailures: 3,
};

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
`;
}

export function loadConfig(overrides?: Partial<Config>): Config {
  const configDir = join(homedir(), ".gnhf");
  const configPath = join(configDir, "config.yml");
  let fileConfig: Partial<Config> = {};
  let shouldBootstrapConfig = false;

  try {
    const raw = readFileSync(configPath, "utf-8");
    fileConfig = (yaml.load(raw) as Partial<Config>) ?? {};
  } catch (error) {
    if (isMissingConfigError(error)) {
      shouldBootstrapConfig = true;
    }

    // Config file doesn't exist or is invalid -- use defaults
  }

  const resolvedConfig = { ...DEFAULT_CONFIG, ...fileConfig, ...overrides };

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
