import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkDiskFree,
  dirSizeSync,
  formatMb,
  useRunTmpDir,
  type DiskUsage,
  type StatfsFn,
} from "./disk.js";

function fakeStatfs(freeBytes: number, totalBytes = 1024 * 1024 * 1024): StatfsFn {
  return (path: string) =>
    path === "throw"
      ? Promise.reject(new Error("statfs boom"))
      : Promise.resolve({ freeBytes, totalBytes } satisfies DiskUsage);
}

const MB = 1024 * 1024;

describe("checkDiskFree", () => {
  it("is disabled when the minimum is 0 or unset", async () => {
    expect(await checkDiskFree("/x", { minFreeBytes: 0 })).toEqual({
      kind: "disabled",
    });
    expect(await checkDiskFree("/x", { minFreeBytes: -1 })).toEqual({
      kind: "disabled",
    });
  });

  it("reports ok above 2x the minimum", async () => {
    const out = await checkDiskFree("/x", {
      minFreeBytes: 100 * MB,
      statfsFn: fakeStatfs(300 * MB),
    });
    expect(out).toEqual({ kind: "ok", freeBytes: 300 * MB });
  });

  it("warns between the minimum and 2x the minimum", async () => {
    const out = await checkDiskFree("/x", {
      minFreeBytes: 100 * MB,
      statfsFn: fakeStatfs(150 * MB),
    });
    expect(out).toEqual({ kind: "warn", freeBytes: 150 * MB });
  });

  it("reports below at the minimum (stop the run)", async () => {
    const out = await checkDiskFree("/x", {
      minFreeBytes: 100 * MB,
      statfsFn: fakeStatfs(99 * MB),
    });
    expect(out).toEqual({ kind: "below", freeBytes: 99 * MB });
  });

  it("fails open when statfs errors (a probe failure is not ENOSPC)", async () => {
    const out = await checkDiskFree("throw", {
      minFreeBytes: 100 * MB,
      statfsFn: fakeStatfs(0),
    });
    expect(out).toEqual({ kind: "error", error: "statfs boom" });
  });
});

describe("dirSizeSync", () => {
  it("sums files under a directory and tolerates missing dirs", () => {
    const root = mkdtempSync(join(tmpdir(), "gnhf-disk-test-"));
    try {
      writeFileSync(join(root, "a.txt"), "x".repeat(100));
      const sub = join(root, "sub");
      mkdirSync(sub);
      writeFileSync(join(sub, "b.txt"), "x".repeat(50));
      expect(dirSizeSync(root)).toBe(150);
      expect(dirSizeSync(join(root, "does-not-exist"))).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("useRunTmpDir", () => {
  it("creates a tmp dir under the run dir, redirects TMPDIR, and cleans up", () => {
    const runDir = mkdtempSync(join(tmpdir(), "gnhf-run-tmp-test-"));
    const prevTmpdir = process.env.TMPDIR;
    try {
      const tmp = useRunTmpDir(runDir);
      expect(tmp.dir.startsWith(runDir)).toBe(true);
      expect(process.env.TMPDIR).toBe(tmp.dir);
      writeFileSync(join(tmp.dir, "leftover.txt"), "data");
      expect(dirSizeSync(tmp.dir)).toBe(4);
      tmp.cleanup();
      expect(existsSync(tmp.dir)).toBe(false);
    } finally {
      if (prevTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmpdir;
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});

describe("formatMb", () => {
  it("renders whole megabytes", () => {
    expect(formatMb(256 * MB)).toBe("256 MB");
    expect(formatMb(0)).toBe("0 MB");
  });
});
