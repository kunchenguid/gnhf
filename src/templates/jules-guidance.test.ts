import { describe, expect, it } from "vitest";
import { buildJulesGuidance, JULES_GUIDANCE } from "./jules-guidance.js";

describe("buildJulesGuidance", () => {
  it("captures the remote Jules delegation policy", () => {
    const guidance = buildJulesGuidance();

    expect(guidance).toContain("runs remotely");
    expect(guidance).toContain("slower than local work");
    expect(guidance).toContain("creates its own branch and PR");
    expect(guidance).toContain("Prefer Jules for isolated, longer-running tasks");
    expect(guidance).toContain("Do not use Jules for quick local edits");
    expect(guidance).toContain("You remain responsible for verifying any Jules result");
  });

  it("is assembled from the canonical guidance list", () => {
    expect(buildJulesGuidance()).toBe(JULES_GUIDANCE.join(" "));
  });
});
