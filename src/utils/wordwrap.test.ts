import { describe, it, expect } from "vitest";
import { wordWrap } from "./wordwrap.js";

describe("wordWrap", () => {
  it("returns single line if text fits", () => {
    expect(wordWrap("hello world", 20)).toEqual(["hello world"]);
  });

  it("wraps at word boundary", () => {
    expect(wordWrap("hello world foo", 11)).toEqual(["hello world", "foo"]);
  });

  it("breaks long words that exceed width", () => {
    expect(wordWrap("abcdefghij", 5)).toEqual(["abcde", "fghij"]);
  });

  it("treats BMP full-width characters as double-width", () => {
    expect(wordWrap("漢A", 2)).toEqual(["漢", "A"]);
  });

  it("keeps ZWJ emoji graphemes intact when wrapping", () => {
    expect(wordWrap("👨‍👩‍👧‍👦", 2)).toEqual(["👨‍👩‍👧‍👦"]);
  });

  it("caps at maxLines with ellipsis on last line", () => {
    const text = "one two three four five six seven eight";
    const lines = wordWrap(text, 10, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/…$/);
  });

  it("returns empty array for empty string", () => {
    expect(wordWrap("", 20)).toEqual([]);
  });
});
