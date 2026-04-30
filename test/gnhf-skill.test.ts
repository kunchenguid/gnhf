import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const skillPath = "skills/gnhf/SKILL.md";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

describe("gnhf skill package artifact", () => {
  it("defines skill metadata in frontmatter", () => {
    const skill = readFileSync(resolve(repoRoot, skillPath), "utf8");
    const match = /^---\n(?<frontmatter>[\s\S]*?)\n---\n/.exec(skill);

    expect(match?.groups?.frontmatter).toBeDefined();

    const metadata = load(match?.groups?.frontmatter ?? "") as {
      name?: unknown;
      description?: unknown;
    };

    expect(metadata.name).toBe("gnhf");
    expect(metadata.description).toEqual(expect.stringContaining("GNHF"));
  });

  it("includes the skill in the npm package", () => {
    const output = execFileSync(npmCommand, ["pack", "--dry-run", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const [packument] = JSON.parse(output) as Array<{
      files?: Array<{ path?: string }>;
    }>;

    expect(packument.files?.map((file) => file.path)).toContain(skillPath);
  });
});
