import { describe, expect, it } from "vitest";
import { buildAgentOutputSchema } from "./types.js";

describe("buildAgentOutputSchema", () => {
  it("adds configured commit message fields to properties and required", () => {
    const schema = buildAgentOutputSchema({
      includeStopField: false,
      commitFields: [
        {
          name: "type",
          allowed: ["feat", "fix"],
        },
        {
          name: "scope",
        },
      ],
    });

    expect(schema.properties.type).toEqual({
      type: "string",
      enum: ["feat", "fix"],
    });
    expect(schema.properties.scope).toEqual({ type: "string" });
    expect(schema.required).toContain("type");
    expect(schema.required).toContain("scope");
  });
});
