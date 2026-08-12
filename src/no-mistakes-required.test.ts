import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import yaml from "js-yaml";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporaryDirectories: string[] = [];

function verificationScript(): string {
  const workflow = yaml.load(
    readFileSync(
      join(root, ".github", "workflows", "no-mistakes-required.yml"),
      "utf8",
    ),
  ) as {
    jobs: { check: { steps: Array<{ name?: string; run?: string }> } };
  };
  const step = workflow.jobs.check.steps.find(
    ({ name }) => name === "Verify no-mistakes signature in PR body",
  );
  if (!step?.run) throw new Error("no-mistakes verification step is missing");
  return step.run;
}

function runVerification(signedAfter: number) {
  const temp = mkdtempSync(join(tmpdir(), "gnhf-no-mistakes-check-"));
  temporaryDirectories.push(temp);
  const bin = join(temp, "bin");
  const countFile = join(temp, "gh-count");
  mkdirSync(bin);

  const gh = join(bin, "gh");
  writeFileSync(
    gh,
    `#!/bin/sh
set -eu
count=0
if [ -f "$MOCK_GH_COUNT_FILE" ]; then
  count="$(cat "$MOCK_GH_COUNT_FILE")"
fi
count=$((count + 1))
printf '%s' "$count" > "$MOCK_GH_COUNT_FILE"
if [ "$count" -ge "$MOCK_SIGNED_AFTER" ]; then
  printf '%s\n' "$MOCK_SIGNED_BODY"
else
  printf '%s\n' "$MOCK_UNSIGNED_BODY"
fi
`,
  );
  chmodSync(gh, 0o755);

  const sleep = join(bin, "sleep");
  writeFileSync(sleep, "#!/bin/sh\nexit 0\n");
  chmodSync(sleep, 0o755);

  const result = spawnSync("bash", ["-c", verificationScript()], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      GH_TOKEN: "test-token",
      GITHUB_REPOSITORY: "kunchenguid/gnhf",
      PR_AUTHOR: "contributor",
      PR_NUMBER: "198",
      MOCK_GH_COUNT_FILE: countFile,
      MOCK_SIGNED_AFTER: String(signedAfter),
      MOCK_UNSIGNED_BODY: "## What Changed\n\nPending pipeline summary.",
      MOCK_SIGNED_BODY:
        "## Pipeline\n\nUpdates from [git push no-mistakes](https://github.com/kunchenguid/no-mistakes)",
    },
  });

  return {
    ...result,
    calls: Number(readFileSync(countFile, "utf8")),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === "win32")(
  "no-mistakes PR signature workflow",
  () => {
    it("accepts a signature written shortly after the synchronize event", () => {
      const result = runVerification(2);

      expect(result.status).toBe(0);
      expect(result.calls).toBe(2);
      expect(result.stdout).toContain(
        "Found no-mistakes signature in PR #198 body.",
      );
    });

    it("still rejects a PR whose live body remains unsigned", () => {
      const result = runVerification(6);

      expect(result.status).toBe(1);
      expect(result.calls).toBe(5);
      expect(result.stderr).toContain(
        "This PR was not raised through no-mistakes.",
      );
    });
  },
);
