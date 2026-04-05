import { execFileSync } from "node:child_process";
import {
  type AgentOutput,
  type AsyncAgent,
  type AsyncAgentSession,
  type AsyncAgentPollResult,
  type TokenUsage,
} from "./types.js";
import {
  JulesClient,
  type JulesClientOptions,
  type JulesSession,
  type JulesActivity,
} from "./jules-api.js";

const GITHUB_REMOTE_RE =
  /(?:git@github\.com:|https:\/\/github\.com\/)([^/]+)\/([^/.]+?)(?:\.git)?$/;

export interface JulesAgentDeps {
  apiKey?: string;
  baseUrl?: string;
  platform?: NodeJS.Platform;
}

export class JulesAgent implements AsyncAgent {
  name = "jules";

  private client: JulesClient;
  private platform: NodeJS.Platform;

  constructor(deps: JulesAgentDeps = {}) {
    const clientOptions: JulesClientOptions = {};
    if (deps.apiKey) clientOptions.apiKey = deps.apiKey;
    if (deps.baseUrl) clientOptions.baseUrl = deps.baseUrl;
    this.client = new JulesClient(clientOptions);
    this.platform = deps.platform ?? process.platform;
  }

  async submit(prompt: string, cwd: string): Promise<AsyncAgentSession> {
    const repoInfo = this.detectGitHubRepo(cwd);

    let session: JulesSession;

    if (repoInfo) {
      session = await this.client.createSession({
        prompt,
        title: prompt.slice(0, 100),
        sourceContext: {
          source: `sources/github-${repoInfo.owner}-${repoInfo.repo}`,
          githubRepoContext: {
            startingBranch: repoInfo.branch ?? "main",
          },
        },
        requirePlanApproval: false,
        automationMode: "AUTO_CREATE_PR",
      });
    } else {
      session = await this.client.createSession({
        prompt,
        title: prompt.slice(0, 100),
      });
    }

    return {
      id: session.id,
      url: session.url ?? `https://jules.google.com/session/${session.id}`,
      repo: repoInfo ? `${repoInfo.owner}/${repoInfo.repo}` : undefined,
    };
  }

  async poll(session: AsyncAgentSession): Promise<AsyncAgentPollResult> {
    const julesSession = await this.client.getSession(session.id);
    const state = this.mapState(julesSession.state);

    if (state === "completed") {
      return this.extractCompletedResult(session, julesSession);
    }

    if (state === "failed") {
      return { status: "failed", reason: "Session failed" };
    }

    return { status: state };
  }

  private mapState(julesState: string): AsyncAgentPollResult["status"] {
    switch (julesState) {
      case "QUEUED":
        return "queued";
      case "PLANNING":
        return "planning";
      case "AWAITING_PLAN_APPROVAL":
        return "awaiting_plan_approval";
      case "IN_PROGRESS":
        return "in_progress";
      case "COMPLETED":
        return "completed";
      case "FAILED":
        return "failed";
      default:
        return "queued";
    }
  }

  private async extractCompletedResult(
    session: AsyncAgentSession,
    julesSession: JulesSession,
  ): Promise<AsyncAgentPollResult> {
    const prOutput = julesSession.outputs?.find((o) => o.pullRequest);
    const pullRequestUrl = prOutput?.pullRequest?.url;

    let patch: string | undefined;
    let commitMessage: string | undefined;

    if (pullRequestUrl) {
      patch = this.fetchPrDiff(pullRequestUrl);
      commitMessage = prOutput?.pullRequest?.title;
    } else {
      const activities = await this.client.getActivities(session.id);
      const changeSet = this.findChangeSet(activities);
      if (changeSet?.gitPatch) {
        patch = changeSet.gitPatch.unidiffPatch;
        commitMessage = changeSet.gitPatch.suggestedCommitMessage;
      }
    }

    return {
      status: "completed",
      pullRequestUrl,
      patch,
      commitMessage,
      summary: julesSession.title ?? julesSession.prompt.slice(0, 100),
      keyChangesMade: commitMessage ? [commitMessage] : [],
      keyLearnings: [],
    };
  }

  private detectGitHubRepo(
    cwd: string,
  ): { owner: string; repo: string; branch: string | null } | null {
    try {
      const remoteUrl = execFileSync("git", ["remote", "get-url", "origin"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();

      const match = remoteUrl.match(GITHUB_REMOTE_RE);
      if (!match) return null;

      let branch: string | null = null;
      try {
        branch =
          execFileSync("git", ["branch", "--show-current"], {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim() || null;
      } catch {
        // Best effort
      }

      return { owner: match[1], repo: match[2], branch };
    } catch {
      return null;
    }
  }

  private fetchPrDiff(prUrl: string): string | undefined {
    try {
      const prNumber = prUrl.match(/\/pull\/(\d+)/)?.[1];
      if (!prNumber) return undefined;

      return execFileSync("gh", ["pr", "diff", prNumber], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 30_000,
      });
    } catch {
      return undefined;
    }
  }

  private findChangeSet(
    activities: JulesActivity[],
  ): JulesActivity["changeSet"] | undefined {
    for (let i = activities.length - 1; i >= 0; i--) {
      if (activities[i].changeSet?.gitPatch?.unidiffPatch) {
        return activities[i].changeSet;
      }
    }
    return undefined;
  }

  async close(): Promise<void> {
    // No persistent resources to clean up
  }
}
