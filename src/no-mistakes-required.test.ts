import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import yaml from "js-yaml";

const root = fileURLToPath(new URL("..", import.meta.url));
const workflow = yaml.load(
  readFileSync(
    new URL("../.github/workflows/no-mistakes-required.yml", import.meta.url),
    "utf8",
  ),
) as {
  jobs: {
    check: {
      steps: Array<{ name: string; run?: string }>;
    };
  };
};

const workflowCheckScript = workflow.jobs.check.steps.find(
  (step) => step.name === "Verify no-mistakes signature in PR body",
)?.run;

if (!workflowCheckScript) {
  throw new Error(
    "no-mistakes workflow is missing its PR-body verification step",
  );
}

const checkScript: string = workflowCheckScript;

function runCheck(body: string, headSha: string): number | null {
  return spawnSync("bash", ["-c", checkScript], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PR_BODY: body,
      PR_AUTHOR: "contributor",
      PR_HEAD_SHA: headSha,
      PR_NUMBER: "199",
    },
  }).status;
}

describe("no-mistakes PR-body check", () => {
  it("accepts the pipeline attestation produced for the PR head", () => {
    const headSha = "1ff8eced493be393e0fdc34fb7b6b6bb9f6f14bb";
    const body = [
      "Fixes #192",
      "",
      '<!-- no-mistakes-pipeline-attestation:v1 {"head_sha":"1ff8eced493be393e0fdc34fb7b6b6bb9f6f14bb","steps":[]} -->',
    ].join("\n");

    expect(runCheck(body, headSha)).toBe(0);
  });

  it("rejects an attestation for a different commit", () => {
    const body =
      '<!-- no-mistakes-pipeline-attestation:v1 {"head_sha":"different","steps":[]} -->';

    expect(runCheck(body, "1ff8eced493be393e0fdc34fb7b6b6bb9f6f14bb")).not.toBe(
      0,
    );
  });
});
