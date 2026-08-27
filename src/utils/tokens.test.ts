import { describe, it, expect } from "vitest";
import { formatTokens, getTotalTokenCount } from "./tokens.js";

describe("formatTokens", () => {
  it("returns raw number for values under 1000", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1)).toBe("1");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats thousands as K (rounded)", () => {
    expect(formatTokens(1000)).toBe("1K");
    expect(formatTokens(1499)).toBe("1K");
    expect(formatTokens(1500)).toBe("2K");
    expect(formatTokens(999_999)).toBe("1000K");
  });

  it("formats millions as M (one decimal)", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(formatTokens(12_345_678)).toBe("12.3M");
  });

  it("formats billions as B (one decimal)", () => {
    expect(formatTokens(1_000_000_000)).toBe("1.0B");
    expect(formatTokens(2_500_000_000)).toBe("2.5B");
    expect(formatTokens(123_456_789_000)).toBe("123.5B");
  });

  it("formats trillions as T (one decimal)", () => {
    expect(formatTokens(1_000_000_000_000)).toBe("1.0T");
    expect(formatTokens(3_700_000_000_000)).toBe("3.7T");
  });
});

describe("getTotalTokenCount", () => {
  it("includes cache reads and cache writes", () => {
    expect(getTotalTokenCount(2, 3, 40, 30)).toBe(75);
  });

  it("defaults cache token counts to zero", () => {
    expect(getTotalTokenCount(50, 100)).toBe(150);
  });
});
