import { describe, expect, it } from "vitest";
import { graphemeWidth } from "./terminal-width.js";

describe("graphemeWidth", () => {
  it("treats narrow supplementary-plane graphemes as single-width", () => {
    expect(graphemeWidth("𝒜")).toBe(1);
  });
});
