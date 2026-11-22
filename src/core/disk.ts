// Disk-usage guard: the unattended loop must defend itself against a full
// temp disk (the ENOSPC-at-3am failure mode), and iteration temp files must
// be tracked and removed when the run ends. See README "Disk guard".
import { statfs } from "node:fs/promises";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export interface DiskUsage {
  freeBytes: number;
  totalBytes: number;
}

// Injectable seam (tests provide a fake; production uses node:fs statfs,
// which reports `bavail * bsize`: free bytes available to UNPRIVILEGED users,
// the number that actually matters when a run is not root).
export type StatfsFn = (path: string) => Promise<DiskUsage>;

export async function defaultStatfs(path: string): Promise<DiskUsage> {
  const s = await statfs(path);
  return {
    freeBytes: Number(s.bavail) * Number(s.bsize),
    totalBytes: Number(s.blocks) * Number(s.bsize),
  };
}

export type DiskCheckOutcome =
  | { kind: "disabled" }
  | { kind: "error"; error: string } // statfs failed: fail-open, warn only
  | { kind: "ok"; freeBytes: number } // >= 2x minimum
  | { kind: "warn"; freeBytes: number } // >= minimum but below 2x
  | { kind: "below"; freeBytes: number }; // < minimum: stop before iterating

export interface DiskGuardOptions {
  // 0 or undefined disables the guard entirely (user's explicit choice).
  minFreeBytes: number;
  statfsFn?: StatfsFn;
}

export function checkDiskFree(
  path: string,
  opts: DiskGuardOptions,
): Promise<DiskCheckOutcome> {
  const min = opts.minFreeBytes;
  if (!Number.isFinite(min) || min <= 0) {
    return Promise.resolve({ kind: "disabled" });
  }
  const statfsFn = opts.statfsFn ?? defaultStatfs;
  return statfsFn(path)
    .then((usage): DiskCheckOutcome => {
      const { freeBytes } = usage;
      if (freeBytes < min) return { kind: "below", freeBytes };
      if (freeBytes < min * 2) return { kind: "warn", freeBytes };
      return { kind: "ok", freeBytes };
    })
    .catch((err: unknown): DiskCheckOutcome => ({
      kind: "error",
      error: err instanceof Error ? err.message : String(err),
    }));
}

export function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

// Bounded size walk: iteration temp dirs can be large or volatile, so the
// walker stops after `maxEntries` entries and treats vanished files as 0.
// An approximate size is the honest budget for a status line.
export function dirSizeSync(dir: string, maxEntries = 5000): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  let visited = 0;
  const walk = (p: string): void => {
    if (visited >= maxEntries) return;
    let names: string[];
    try {
      names = readdirSync(p);
    } catch {
      return; // unreadable subtree contributes 0, not a crash
    }
    for (const name of names) {
      if (visited >= maxEntries) return;
      visited++;
      const full = join(p, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
        } else if (st.isFile()) {
          total += st.size;
        }
      } catch {
        // vanished mid-walk: contributes 0
      }
    }
  };
  walk(dir);
  return total;
}

export interface RunTmpDir {
  dir: string;
  cleanup: () => void;
}

// Per-run TMPDIR: iteration temp files land UNDER the run directory
// (.gnhf/runs/<runId>/tmp — already excluded from git via the run dir), so a
// night's temp footprint is trackable and removable instead of leaking into
// the shared /tmp until the machine reboots.
export function useRunTmpDir(runDir: string): RunTmpDir {
  const dir = join(runDir, "tmp");
  let created = false;
  try {
    mkdirSync(dir, { recursive: true });
    created = true;
  } catch {
    // Fail-open: if the per-run tmp dir cannot be created, the run keeps its
    // inherited temp dir rather than ending the night. The disk guard still
    // protects the filesystem; only the tracking is lost.
  }
  if (!created) {
    return { dir, cleanup: () => {} };
  }
  // POSIX honors TMPDIR; Windows tooling mostly honors TMP/TEMP. Set all
  // three so agent child processes (and node's own os.tmpdir()) agree.
  // The previous values are RESTORED on cleanup: cleanup must not leave the
  // process pointing at a directory it just deleted.
  const previous: Record<string, string | undefined> = {
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
  };
  process.env.TMPDIR = dir;
  process.env.TMP = dir;
  process.env.TEMP = dir;
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort: a locked file must not turn cleanup into a crash.
      }
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    },
  };
}
