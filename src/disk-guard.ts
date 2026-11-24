// src/disk-guard.ts
// Parallel worktrees can fill the disk within an hour (mostly the Go build
// cache), and a session that hits ENOSPC cannot run a single shell command, so
// it stops. This guard watches free space on the volumes sessions write to.
// Below lowBytes it marks the disk low and runs `relieve` (an aggressive cache
// trim) on every check. It clears only once every volume is back above highBytes,
// so it doesn't flap at the boundary. While the disk is low, callers hold new
// session launches and idle nudges.
import { statfs } from "node:fs/promises";

const GB = 1e9;

// A positive GB count from the environment, else the fallback.
export function parseDiskGb(raw: string | undefined, fallbackGb: number): number {
  const gb = Number(raw);
  return (Number.isFinite(gb) && gb > 0 ? gb : fallbackGb) * GB;
}

// Bytes available to an unprivileged writer on path's volume and the volume's
// size, or null when the path does not exist or cannot be statted.
export async function spaceOf(path: string): Promise<{ bytes: number; size: number } | null> {
  try {
    const s = await statfs(path);
    return { bytes: s.bavail * s.bsize, size: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

export type FreeSpace = { path: string; bytes: number; size: number };

export async function volumes(
  paths: string[],
  stat: (path: string) => Promise<{ bytes: number; size: number } | null> = spaceOf,
): Promise<FreeSpace[]> {
  const out: FreeSpace[] = [];
  for (const path of paths) {
    const space = await stat(path);
    if (space) out.push({ path, ...space });
  }
  return out;
}

// A small volume (a RAM-backed /tmp) could never reach fixed GB marks, so each
// mark is capped at a share of the volume's size.
const LOW_SHARE = 0.25;
const HIGH_SHARE = 0.5;

function marksFor(space: FreeSpace, lowBytes: number, highBytes: number) {
  return { ...space, low: Math.min(lowBytes, space.size * LOW_SHARE), high: Math.min(highBytes, space.size * HIGH_SHARE) };
}

export type DiskGuardState = { low: boolean };

export function freshDiskGuardState(): DiskGuardState {
  return { low: false };
}

export type DiskGuardDeps = {
  free: () => Promise<FreeSpace[]>;
  lowBytes: number;
  highBytes: number;
  // Free up space. Runs on every check while the disk is low.
  relieve: () => Promise<void>;
  log: (msg: string) => void;
};

const gb = (bytes: number) => `${(bytes / GB).toFixed(1)}G`;

export async function checkDisk(state: DiskGuardState, deps: DiskGuardDeps): Promise<void> {
  const spaces = (await deps.free()).map((s) => marksFor(s, deps.lowBytes, deps.highBytes));
  if (spaces.length === 0) return; // nothing measurable: keep the last verdict
  const short = spaces.find((s) => s.bytes < s.low);
  if (!state.low && short) {
    state.low = true;
    deps.log(
      `disk low: ${gb(short.bytes)} free on ${short.path} (< ${gb(short.low)}); ` +
        `trimming caches and holding new launches and idle nudges until ${gb(short.high)} free`,
    );
  } else if (state.low && spaces.every((s) => s.bytes >= s.high)) {
    state.low = false;
    const tightest = spaces.reduce((a, b) => (b.bytes < a.bytes ? b : a));
    deps.log(`disk recovered: ${gb(tightest.bytes)} free on ${tightest.path}; resuming launches and nudges`);
  }
  if (state.low) await deps.relieve();
}
