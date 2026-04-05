import { execFileSync } from "node:child_process";
import type {
  AgentResult,
  AsyncAgentSession,
  AsyncAgentPollResult,
  AgentRunOptions,
} from "./types.js";
import { JulesClient } from "./jules-api.js";

export class JulesAgent {
  name = "jules";

  private client: JulesClient;
  private platform: NodeJS.Platform;

  constructor(deps: { bin?: string; platform?: NodeJS.Platform } = {}) {
    // bin is accepted for API consistency but ignored — Jules is cloud-only
    this.client = new JulesClient();
    this.platform = deps.platform ?? process.platform;
  }

  async run(
    _prompt: string,
    _cwd: string,
    _options?: AgentRunOptions,
  ): Promise<AgentResult> {
    throw new Error("JulesAgent must be wrapped by AsyncAgentAdapter");
  }

  async submit(prompt: string, cwd: string): Promise<AsyncAgentSession> {
    const cwdUrl = `file://${cwd}`;
    const session = await this.client.createSession({
      prompt,
      sourceContext: {
        source: "github",
        githubRepoContext: {
          startingBranch: this.getCurrentBranch(cwd),
        },
      },
      automationMode: "MANUAL",
      requirePlanApproval: false,
    });

    return {
      id: session.id,
      url: session.url ?? `https://jules.google.com/workspace/${session.id}`,
      repo: cwdUrl,
    };
  }

  async poll(session: AsyncAgentSession): Promise<AsyncAgentPollResult> {
    const julesSession = await this.client.getSession(session.id);

    switch (julesSession.state) {
      case "completed":
        const activities = await this.client.getActivities(session.id);
        const pullRequestUrl = julesSession.outputs?.find(
          (output) => output.pullRequest?.url,
        )?.pullRequest?.url;
        const changes = activities
          .filter((a) => a.changeSet?.gitPatch?.unidiffPatch)
          .map(
            (a) =>
              a.changeSet!.gitPatch!.suggestedCommitMessage ??
              "Applied changes",
          );

        return {
          status: "completed",
          summary: julesSession.title ?? `Completed session ${session.id}`,
          keyChangesMade: changes,
          pullRequestUrl,
        };

      case "failed":
        return {
          status: "failed",
          reason: `Session state: failed`,
        };

      case "pending":
      case "queued":
        return { status: "queued" };

      case "planning":
        return { status: "planning" };

      case "in_progress":
        return { status: "in_progress" };

      default:
        return { status: "in_progress" };
    }
  }

  private getCurrentBranch(cwd: string): string {
    try {
      return execFileSync("git", ["branch", "--show-current"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "main";
    }
  }

  async close(): Promise<void> {}
}
