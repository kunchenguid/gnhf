import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readStdinText } from "./stdin.js";

describe("readStdinText", () => {
  it("reads and trims text from a stream", async () => {
    const input = Readable.from(["ship it\n"]);

    await expect(readStdinText(input)).resolves.toBe("ship it");
  });

  it("supports Buffer chunks", async () => {
    const input = Readable.from([
      Buffer.from("multi"),
      Buffer.from(" line\nobjective\n"),
    ]);

    await expect(readStdinText(input)).resolves.toBe("multi line\nobjective");
  });
});
