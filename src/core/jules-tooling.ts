import type { Config, AgentName } from "./config.js";
import { saveConfig } from "./config.js";
import { buildJulesGuidance } from "../templates/jules-guidance.js";

type JulesAwareAgentName = Exclude<AgentName, "jules">;

export function isJulesConfigured(env: NodeJS.ProcessEnv): boolean {
  return (env.JULES_API_KEY ?? "").trim().length > 0;
}

export function getVisibleAgentNames(
  config: Config,
  env: NodeJS.ProcessEnv,
): AgentName[] {
  const allAgents: AgentName[] = [
    "claude",
    "codex",
    "rovodev",
    "opencode",
    "gemini",
    "copilot",
    "junie",
    "jules",
    "kilo",
  ];

  if (isJulesVisible(config, env)) {
    return allAgents;
  }

  return allAgents.filter((agent) => agent !== "jules");
}

export function getJulesPromptGuidance(
  agent: AgentName,
  config: Config,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (agent === "jules") return undefined;
  if (!isJulesVisible(config, env)) return undefined;
  return buildJulesGuidance();
}

export async function maybePromptForJulesSetup(
  config: Config,
  env: NodeJS.ProcessEnv,
  isInteractive: boolean,
  deps: {
    ask?: (question: string) => Promise<string>;
    write?: (message: string) => void;
    saveConfig?: (config: Config) => void;
  } = {},
): Promise<Config> {
  if (!isInteractive) return config;
  if (isJulesConfigured(env)) return config;
  if (config.jules?.dismissed) return config;

  const ask = deps.ask ?? (async () => "d");
  const write = deps.write ?? (() => {});
  const persist = deps.saveConfig ?? saveConfig;

  const answer = (await ask(
    'Jules is available as an optional remote tool. It runs slower than local work and creates its own branch/PR. Set it up now or dismiss it? [y/d]: ',
  ))
    .trim()
    .toLowerCase();

  if (answer === "y") {
    write(
      '\nTo enable Jules, install/configure your Jules environment and set JULES_API_KEY in your shell. Until then, gnhf will keep Jules hidden from prompts and agent selection.\n',
    );
    return config;
  }

  const nextConfig: Config = {
    ...config,
    jules: {
      ...config.jules,
      dismissed: true,
    },
  };
  persist(nextConfig);
  return nextConfig;
}

function isJulesVisible(config: Config, env: NodeJS.ProcessEnv): boolean {
  return isJulesConfigured(env) && !config.jules?.dismissed;
}

export type { JulesAwareAgentName };
