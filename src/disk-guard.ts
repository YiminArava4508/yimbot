// src/disk-guard.ts
// Parallel worktrees can fill the disk within an hour (mostly the Go build
// cache), and a session that hits ENOSPC cannot run a single shell command, so
// it stops. This guard watches free space on the volumes sessions write to.
// Below lowBytes it marks the disk low and runs `relieve` (an aggressive cache
// trim) on every check. It clears only once free space is back above highBytes,
// so it doesn't flap at the boundary. While the disk is low, callers hold new
// session launches and idle nudges.
import { statfs } from "node:fs/promises";

const GB = 1e9;

// A positive GB count from the environment, else the fallback.
export function parseDiskGb(raw: string | undefined, fallbackGb: number): number {
  const gb = Number(raw);
  return (Number.isFinite(gb) && gb > 0 ? gb : fallbackGb) * GB;
}

// Bytes available to an unprivileged writer on path's volume, or null when the
// path does not exist or cannot be statted.
export async function freeBytesOf(path: string): Promise<number | null> {
  try {
    const s = await statfs(path);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

export type FreeSpace = { path: string; bytes: number };

// The tightest volume among paths (several usually share one volume). Null
// when none could be statted.
export async function tightestVolume(
  paths: string[],
  free: (path: string) => Promise<number | null> = freeBytesOf,
): Promise<FreeSpace | null> {
  let min: FreeSpace | null = null;
  for (const path of paths) {
    const bytes = await free(path);
    if (bytes === null) continue;
    if (!min || bytes < min.bytes) min = { path, bytes };
  }
  return min;
}

export type DiskGuardState = { low: boolean };

export function freshDiskGuardState(): DiskGuardState {
  return { low: false };
}

export type DiskGuardDeps = {
  free: () => Promise<FreeSpace | null>;
  lowBytes: number;
  highBytes: number;
  // Free up space. Runs on every check while the disk is low.
  relieve: () => Promise<void>;
  log: (msg: string) => void;
};

const gb = (bytes: number) => `${(bytes / GB).toFixed(1)}G`;

export async function checkDisk(state: DiskGuardState, deps: DiskGuardDeps): Promise<void> {
  const space = await deps.free();
  if (!space) return; // nothing measurable: keep the last verdict
  if (!state.low && space.bytes < deps.lowBytes) {
    state.low = true;
    deps.log(
      `disk low: ${gb(space.bytes)} free on ${space.path} (< ${gb(deps.lowBytes)}); ` +
        `trimming caches and holding new launches and idle nudges until ${gb(deps.highBytes)} free`,
    );
  } else if (state.low && space.bytes >= deps.highBytes) {
    state.low = false;
    deps.log(`disk recovered: ${gb(space.bytes)} free on ${space.path}; resuming launches and nudges`);
  }
  if (state.low) await deps.relieve();
}
