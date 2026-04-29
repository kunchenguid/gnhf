import { describe, it, expect } from "vitest";
import { slugifyPrompt } from "./slugify.js";

describe("slugifyPrompt", () => {
  it("lowercases and replaces non-alphanumeric chars with hyphens", () => {
    const result = slugifyPrompt("Hello World");
    expect(result).toMatch(/^gnhf\/hello-world-[a-f0-9]{6}$/);
  });

  it("strips leading and trailing hyphens from slug portion", () => {
    const result = slugifyPrompt("---test---");
    expect(result).toMatch(/^gnhf\/test-[a-f0-9]{6}$/);
  });

  it("truncates slug to 20 characters before hash", () => {
    const longPrompt = "this is a very long prompt that should be truncated";
    const result = slugifyPrompt(longPrompt);
    const slug = result.replace(/^gnhf\//, "").replace(/-[a-f0-9]{6}$/, "");
    expect(slug.length).toBeLessThanOrEqual(20);
  });

  it("does not leave trailing hyphens after truncation", () => {
    // "improve test coverage" truncated at 20 chars could end with hyphen
    const result = slugifyPrompt("improve test coverage of this repo");
    const slug = result.replace(/^gnhf\//, "").replace(/-[a-f0-9]{6}$/, "");
    expect(slug).not.toMatch(/-$/);
  });

  it("produces deterministic output (same prompt -> same result)", () => {
    const a = slugifyPrompt("deterministic test");
    const b = slugifyPrompt("deterministic test");
    expect(a).toBe(b);
  });

  it("produces different hashes for different prompts", () => {
    const a = slugifyPrompt("prompt one");
    const b = slugifyPrompt("prompt two");
    expect(a).not.toBe(b);
  });

  it("prefixes with gnhf/", () => {
    expect(slugifyPrompt("test")).toMatch(/^gnhf\//);
  });
});
