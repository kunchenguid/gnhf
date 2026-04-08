import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

describe("typecheck setup", () => {
  it("exposes a typecheck script that runs TypeScript without emitting", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(repoRoot, "package.json"), "utf8"),
    ) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.typecheck).toMatch(/\btsc\b/);
    expect(packageJson.scripts?.typecheck).toContain("--noEmit");
  });

  it("runs type checking in CI", () => {
    const workflow = readFileSync(
      resolve(repoRoot, ".github/workflows/ci.yml"),
      "utf8",
    );

    expect(workflow).toContain("npm run typecheck");
  });
});
