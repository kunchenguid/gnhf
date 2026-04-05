import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  getActivities: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: mocks.execFileSync,
}));

vi.mock("./jules-api.js", () => ({
  JulesClient: vi.fn(function (this: Record<string, unknown>) {
    this.createSession = mocks.createSession;
    this.getSession = mocks.getSession;
    this.getActivities = mocks.getActivities;
  }),
}));

import { JulesAgent } from "./jules.js";

describe("JulesAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits a session with the current git branch", async () => {
    mocks.execFileSync.mockReturnValue("feat/test-branch\n" as never);
    mocks.createSession.mockResolvedValue({
      id: "session-123",
      url: "https://jules.google.com/s/123",
    });

    const agent = new JulesAgent();
    const session = await agent.submit("ship it", "C:/repo");

    expect(mocks.createSession).toHaveBeenCalledWith({
      prompt: "ship it",
      sourceContext: {
        source: "github",
        githubRepoContext: {
          startingBranch: "feat/test-branch",
        },
      },
      automationMode: "MANUAL",
      requirePlanApproval: false,
    });
    expect(session).toEqual({
      id: "session-123",
      url: "https://jules.google.com/s/123",
      repo: "file://C:/repo",
    });
  });

  it("falls back to main when git branch lookup fails", async () => {
    mocks.execFileSync.mockImplementation(() => {
      throw new Error("git failed");
    });
    mocks.createSession.mockResolvedValue({ id: "session-456" });

    const agent = new JulesAgent();
    await agent.submit("ship it", "C:/repo");

    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceContext: {
          source: "github",
          githubRepoContext: {
            startingBranch: "main",
          },
        },
      }),
    );
  });

  it("maps completed sessions into completed poll results", async () => {
    mocks.getSession.mockResolvedValue({
      id: "session-123",
      state: "completed",
      prompt: "ship it",
      title: "Done",
      outputs: [
        {
          pullRequest: {
            url: "https://github.com/example/repo/pull/1",
          },
        },
      ],
    });
    mocks.getActivities.mockResolvedValue([
      {
        type: "changes",
        changeSet: {
          gitPatch: {
            unidiffPatch: "diff --git a b",
            suggestedCommitMessage: "Add feature",
          },
        },
      },
      {
        type: "changes",
        changeSet: {
          gitPatch: {
            unidiffPatch: "diff --git c d",
          },
        },
      },
    ]);

    const agent = new JulesAgent();
    const result = await agent.poll({
      id: "session-123",
      url: "https://jules.google.com/s/123",
    });

    expect(result).toEqual({
      status: "completed",
      summary: "Done",
      keyChangesMade: ["Add feature", "Applied changes"],
      pullRequestUrl: "https://github.com/example/repo/pull/1",
    });
  });

  it("maps failed sessions into failed poll results", async () => {
    mocks.getSession.mockResolvedValue({
      id: "session-123",
      state: "failed",
      prompt: "ship it",
    });

    const agent = new JulesAgent();
    const result = await agent.poll({
      id: "session-123",
      url: "https://jules.google.com/s/123",
    });

    expect(result).toEqual({
      status: "failed",
      reason: "Session state: failed",
    });
  });

  it("maps pending and queued sessions into queued poll results", async () => {
    const agent = new JulesAgent();

    mocks.getSession.mockResolvedValueOnce({
      id: "session-pending",
      state: "pending",
      prompt: "ship it",
    });
    await expect(
      agent.poll({ id: "session-pending", url: "https://jules/pending" }),
    ).resolves.toEqual({ status: "queued" });

    mocks.getSession.mockResolvedValueOnce({
      id: "session-queued",
      state: "queued",
      prompt: "ship it",
    });
    await expect(
      agent.poll({ id: "session-queued", url: "https://jules/queued" }),
    ).resolves.toEqual({ status: "queued" });
  });

  it("maps unknown session states to in_progress", async () => {
    mocks.getSession.mockResolvedValue({
      id: "session-unknown",
      state: "mystery-state",
      prompt: "ship it",
    });

    const agent = new JulesAgent();
    const result = await agent.poll({
      id: "session-unknown",
      url: "https://jules/unknown",
    });

    expect(result).toEqual({ status: "in_progress" });
  });
});
