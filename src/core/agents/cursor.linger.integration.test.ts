import { chmodSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CursorAgent } from "./cursor.js";

describe("CursorAgent linger shutdown (real process)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves after shutting down a child that lingers past a success result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gnhf-cursor-linger-"));
    tempDirs.push(dir);
    const bin = join(dir, "linger-agent.mjs");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const content = JSON.stringify({
  success: true,
  summary: "linger integration finished",
  key_changes_made: ["demo"],
  key_learnings: ["shutdown after success result"],
});
process.stdout.write(JSON.stringify({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: content }] },
}) + "\\n");
process.stdout.write(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: content,
  usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
}) + "\\n");
setTimeout(() => {}, 60_000);
`,
      "utf8",
    );
    chmodSync(bin, 0o755);

    const started = Date.now();
    // Spawn the script through the current Node binary: a bare `.mjs` path is
    // not directly executable on Windows and fails with spawn EFTYPE.
    const agent = new CursorAgent({
      bin: process.execPath,
      extraArgs: [bin],
      finalResultGraceMs: 200,
      platform: process.platform === "win32" ? "win32" : "darwin",
    });

    const result = await agent.run("prove linger shutdown", dir);
    const elapsedMs = Date.now() - started;

    expect(result.output.success).toBe(true);
    expect(result.output.summary).toBe("linger integration finished");
    // Child would otherwise block for 60s; grace shutdown must finish first.
    expect(elapsedMs).toBeLessThan(5_000);
  }, 15_000);
});
