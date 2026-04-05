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

  constructor(deps: { platform?: NodeJS.Platform } = {}) {
    this.client = new JulesClient();
    this.platform = deps.platform ?? process.platform;
  }

  async run(
    prompt: string,
    cwd: string,
    _options?: AgentRunOptions,
  ): Promise<AgentResult> {
    const session = await this.submit(prompt, cwd);

    let pollResult = await this.poll(session);
    while (
      pollResult.status !== "completed" &&
      pollResult.status !== "failed"
    ) {
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      pollResult = await this.poll(session);
    }

    if (pollResult.status === "failed") {
      throw new Error(
        `Jules session failed: ${pollResult.reason ?? "Unknown reason"}`,
      );
    }

    return {
      output: {
        success: true,
        summary: pollResult.summary ?? `Jules completed session ${session.id}`,
        key_changes_made: pollResult.keyChangesMade ?? [],
        key_learnings: pollResult.keyLearnings ?? [],
      },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    };
  }

  async submit(prompt: string, cwd: string): Promise<AsyncAgentSession> {
    const cwdUrl = `file://${cwd}`;
    const session = await this.client.createSession({
      prompt,
      sourceContext: {
        source: "gnhf",
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
