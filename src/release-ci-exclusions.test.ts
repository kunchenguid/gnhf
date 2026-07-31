import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import yaml from "js-yaml";

const root = fileURLToPath(new URL("..", import.meta.url));
const workflowsDir = join(root, ".github", "workflows");

/**
 * Derive the exact release-please output set from config + workflow inputs.
 * Keep this aligned with the fleet audit rule in firstmate's release-please CI
 * report: node -> package.json (+ package-lock.json if present), changelog,
 * extra-files, and the manifest path.
 */
function expectedReleaseOutputs(): string[] {
  const config = JSON.parse(
    readFileSync(join(root, "release-please-config.json"), "utf8"),
  ) as {
    "release-type"?: string;
    "changelog-path"?: string;
    "version-file"?: string;
    "extra-files"?: Array<string | { path?: string }>;
    packages?: Record<
      string,
      {
        "release-type"?: string;
        "changelog-path"?: string;
        "version-file"?: string;
        "extra-files"?: Array<string | { path?: string }>;
      }
    >;
  };
  const pkg = config.packages?.["."] ?? {};
  const releaseType = pkg["release-type"] ?? config["release-type"] ?? "node";
  const changelog =
    pkg["changelog-path"] ?? config["changelog-path"] ?? "CHANGELOG.md";

  const expected: string[] = [changelog];
  switch (releaseType) {
    case "simple":
      expected.push(
        pkg["version-file"] ?? config["version-file"] ?? "version.txt",
      );
      break;
    case "node":
      expected.push("package.json");
      if (existsSync(join(root, "package-lock.json"))) {
        expected.push("package-lock.json");
      }
      break;
    case "go":
      break;
    default:
      throw new Error(
        `unsupported release-please release-type for ignore derivation: ${releaseType}`,
      );
  }

  const extra = pkg["extra-files"] ?? config["extra-files"] ?? [];
  for (const entry of extra) {
    const path = typeof entry === "string" ? entry : entry?.path;
    if (path) expected.push(path);
  }

  let manifest = ".release-please-manifest.json";
  const releaseWorkflow = readFileSync(
    join(workflowsDir, "release-please.yml"),
    "utf8",
  );
  const manifestMatch = releaseWorkflow.match(/manifest-file:\s*(\S+)/);
  if (manifestMatch) manifest = manifestMatch[1];
  expected.push(manifest);

  return [...new Set(expected)];
}

function loadWorkflowOn(filePath: string): Record<string, unknown> | null {
  const loaded: unknown = yaml.load(readFileSync(filePath, "utf8"));
  if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) {
    return null;
  }

  // YAML 1.1 may parse a bare `on:` key as boolean true. Prefer the string
  // key; fall back via Reflect so a real boolean key still resolves without
  // indexing a Record by boolean (illegal in TypeScript's PropertyKey).
  const doc = loaded as Record<string, unknown>;
  const on =
    doc.on ??
    Reflect.get(loaded, true as unknown as PropertyKey) ??
    doc["true"];
  if (!on || typeof on !== "object" || Array.isArray(on)) return null;
  return on as Record<string, unknown>;
}

type PullRequestFilter =
  | { kind: "unfiltered" }
  | { kind: "paths-ignore"; paths: string[] }
  | { kind: "paths"; paths: string[] };

function pullRequestFilterCoverage(pr: unknown): PullRequestFilter {
  if (pr == null) {
    return { kind: "unfiltered" };
  }
  if (typeof pr !== "object" || Array.isArray(pr)) {
    // `pull_request:` bare form means no path filter.
    return { kind: "unfiltered" };
  }

  const record = pr as Record<string, unknown>;
  if (Array.isArray(record["paths-ignore"])) {
    return {
      kind: "paths-ignore",
      paths: record["paths-ignore"].map(String),
    };
  }

  if (Array.isArray(record.paths)) {
    return { kind: "paths", paths: record.paths.map(String) };
  }

  return { kind: "unfiltered" };
}

function globMatch(pattern: string, path: string): boolean {
  // Minimal support for the `**` / `*` patterns used in workflow path filters.
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLE::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLE::/g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

function isCovered(filter: PullRequestFilter, releasePath: string): boolean {
  if (filter.kind === "unfiltered") return false;

  if (filter.kind === "paths-ignore") {
    return filter.paths.includes(releasePath);
  }

  // paths allow-list: a release path is "covered" (will not create a run on its
  // own) when no positive pattern matches it, or a later negation excludes it.
  let matched = false;
  for (const pattern of filter.paths) {
    if (pattern.startsWith("!")) {
      const negated = pattern.slice(1);
      if (
        matched &&
        (negated === releasePath || globMatch(negated, releasePath))
      ) {
        matched = false;
      }
      continue;
    }
    if (pattern === releasePath || globMatch(pattern, releasePath)) {
      matched = true;
    }
  }
  // Covered means the path does NOT cause the workflow to run.
  return !matched;
}

describe("release-please CI exclusions", () => {
  const expected = expectedReleaseOutputs();

  it("derives the node release-output set for this repository", () => {
    expect(expected).toEqual([
      "CHANGELOG.md",
      "package.json",
      ".release-please-manifest.json",
    ]);
  });

  it("every pull_request workflow ignores the full release-output set", () => {
    const files = readdirSync(workflowsDir).filter((name) =>
      name.endsWith(".yml"),
    );
    const prWorkflows: { name: string; filter: PullRequestFilter }[] = [];

    for (const name of files) {
      const filePath = join(workflowsDir, name);
      const on = loadWorkflowOn(filePath);
      if (!on || !("pull_request" in on)) continue;
      prWorkflows.push({
        name,
        filter: pullRequestFilterCoverage(on.pull_request),
      });
    }

    expect(prWorkflows.map((w) => w.name).sort()).toEqual([
      "ci.yml",
      "guard-generated-files.yml",
      "no-mistakes-required.yml",
    ]);

    const failures: string[] = [];
    for (const { name, filter } of prWorkflows) {
      const missing = expected.filter((path) => !isCovered(filter, path));
      if (missing.length > 0) {
        failures.push(`${name} missing coverage for: ${missing.join(", ")}`);
      }
    }

    expect(failures).toEqual([]);
  });

  it("does not attach path filters to non-pull_request triggers on ci.yml", () => {
    const on = loadWorkflowOn(join(workflowsDir, "ci.yml"));
    expect(on).not.toBeNull();
    expect(on!.push).toEqual({ branches: ["main"] });
    const pr = on!.pull_request as Record<string, unknown>;
    expect(pr.branches).toEqual(["main"]);
    expect(pr["paths-ignore"]).toEqual([
      ".release-please-manifest.json",
      "CHANGELOG.md",
      "package.json",
    ]);
    expect(on!.release).toBeUndefined();
    expect(on!.workflow_dispatch).toBeUndefined();
  });

  it("keeps bot author exemptions on guard and no-mistakes jobs", () => {
    const guard = readFileSync(
      join(workflowsDir, "guard-generated-files.yml"),
      "utf8",
    );
    const nmr = readFileSync(
      join(workflowsDir, "no-mistakes-required.yml"),
      "utf8",
    );
    expect(guard).toContain("github-actions[bot]");
    expect(guard).toContain("release-please[bot]");
    expect(nmr).toContain("github-actions[bot]");
    expect(nmr).toContain("dependabot[bot]");
    expect(nmr).toContain("release-please[bot]");
  });
});
