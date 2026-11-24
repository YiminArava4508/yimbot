import { execFile } from "node:child_process";
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface TrimResult {
  removed: number;
  freedBytes: number;
}

async function sizeOf(path: string): Promise<number> {
  const st = await lstat(path);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of await readdir(path)) total += await sizeOf(join(path, name));
  return total;
}

// Go refreshes an entry's mtime (hourly at most) each time a build uses it, so
// mtime is last-use. Go's own trim waits 5 days, which with many worktrees
// building in parallel lets the cache grow past 100G.
export async function trimGoCache(
  cacheDir: string,
  maxAgeMs: number,
  now: number = Date.now(),
): Promise<TrimResult> {
  const result: TrimResult = { removed: 0, freedBytes: 0 };
  let buckets: string[];
  try {
    buckets = (await readdir(cacheDir)).filter((name) => /^[0-9a-f]{2}$/.test(name));
  } catch {
    return result;
  }
  const cutoff = now - maxAgeMs;
  for (const bucket of buckets) {
    const bucketPath = join(cacheDir, bucket);
    let entries: string[];
    try {
      entries = await readdir(bucketPath);
    } catch {
      continue;
    }
    for (const name of entries) {
      const path = join(bucketPath, name);
      try {
        const st = await lstat(path);
        if (st.mtimeMs >= cutoff) continue;
        const size = await sizeOf(path);
        await rm(path, { recursive: true, force: true });
        result.removed += 1;
        result.freedBytes += size;
      } catch {
        // A concurrent go build may remove or replace it; skip.
      }
    }
  }
  return result;
}

// Each go build or go test gets a go-build<N> work dir in the temp dir and
// removes it on exit; a build that is killed (an ended session) leaves it
// behind, and on a RAM-backed /tmp a few of those fill it. A live build keeps
// creating b<N> subdirs, so a dir whose own and child mtimes are all past the
// cutoff is abandoned.
export async function sweepGoBuildDirs(
  tmpDirs: string[],
  maxAgeMs: number,
  now: number = Date.now(),
): Promise<TrimResult> {
  const result: TrimResult = { removed: 0, freedBytes: 0 };
  const cutoff = now - maxAgeMs;
  for (const tmp of new Set(tmpDirs)) {
    let names: string[];
    try {
      names = (await readdir(tmp)).filter((name) => /^go-build\d+$/.test(name));
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(tmp, name);
      try {
        if (await touchedSince(path, cutoff)) continue;
        const size = await sizeOf(path);
        await rm(path, { recursive: true, force: true });
        result.removed += 1;
        result.freedBytes += size;
      } catch {
        // Its build may finish and remove it mid-sweep; skip.
      }
    }
  }
  return result;
}

async function touchedSince(dir: string, cutoff: number): Promise<boolean> {
  if ((await lstat(dir)).mtimeMs >= cutoff) return true;
  for (const name of await readdir(dir)) {
    if ((await lstat(join(dir, name))).mtimeMs >= cutoff) return true;
  }
  return false;
}

export async function goCacheDir(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("go", ["env", "GOCACHE"], { timeout: 10_000 });
    const dir = stdout.trim();
    if (!dir || dir === "off") return null;
    return dir;
  } catch {
    return null;
  }
}
