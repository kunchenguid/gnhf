import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// bootstrap-config.golden.yml is the single source for the bootstrap config
// template. config.test.ts pins serializeConfig's output to it; this test pins
// the README's Configuration block to it. When serializeConfig changes, update
// the golden file and the README block to the new output together.
const readNormalized = (url: URL) =>
  readFileSync(url, "utf-8").replace(/\r\n/g, "\n");

const golden = readNormalized(
  new URL("./bootstrap-config.golden.yml", import.meta.url),
);

describe("bootstrap config golden template", () => {
  it("matches the yaml block in README's Configuration section", () => {
    const readme = readNormalized(new URL("../../README.md", import.meta.url));
    const block = readme.match(
      /## Configuration[\s\S]*?```yaml\n([\s\S]*?)```/,
    );
    expect(
      block,
      "README.md must contain a yaml block under ## Configuration",
    ).not.toBeNull();
    expect(block?.[1]).toBe(golden);
  });
});
