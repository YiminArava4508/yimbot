// src/worktree-lock.ts
// The product repo's worktree_lock.py hook blocks any Claude session that edits
// a worktree another live session claimed, which locks every fixer window out of
// the ticket session's worktree. The hook defers entirely to a "slot-machine v2"
// sectioned document ({v, claim, worker, turn}), so the daemon, which already
// allows one fixer per worktree, writes one while a fixer runs and puts the
// previous lock back afterwards. The previous lock travels inside our document,
// so a release works after a daemon restart.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LOCK_NAME = ".worktree-lock";
const OWNER = "yimbot";

export type LockDeps = {
  read: (path: string) => string | null;
  write: (path: string, content: string) => void;
  remove: (path: string) => void;
  // Whether the worktree has uncommitted changes (the lock file itself ignored).
  isDirty: (worktree: string) => boolean;
  now: () => number;
  log: (msg: string) => void;
};

type Doc = Record<string, unknown> & { claim?: { by?: string; previous?: string | null } };

function parse(raw: string | null): Doc | null {
  if (raw === null) return null;
  try {
    const doc = JSON.parse(raw) as unknown;
    return typeof doc === "object" && doc !== null && !Array.isArray(doc) ? (doc as Doc) : null;
  } catch {
    return null;
  }
}

// Mirrors the hook's is_sm_v2_doc: any of claim/worker/turn, or v >= 2.
function isV2(doc: Doc | null): boolean {
  if (doc === null) return false;
  if ("claim" in doc || "worker" in doc || "turn" in doc) return true;
  return typeof doc.v === "number" && Number.isInteger(doc.v) && doc.v >= 2;
}

export function isFixerLock(raw: string | null): boolean {
  return parse(raw)?.claim?.by === OWNER;
}

// `git status --porcelain` output; null (git failed) counts as dirty.
export function worktreeIsDirty(porcelain: string | null): boolean {
  if (porcelain === null) return true;
  return porcelain
    .split("\n")
    .filter(Boolean)
    .some((line) => line.slice(3).trim() !== LOCK_NAME);
}

// Take the worktree's lock for a fixer. False (nothing written) when the
// worktree has uncommitted changes, or an orchestrator already owns it.
export function claimWorktreeForFixer(worktree: string, kind: string, prNumber: number, deps: LockDeps): boolean {
  const path = join(worktree, LOCK_NAME);
  const raw = deps.read(path);
  const existing = parse(raw);
  if (isV2(existing)) return false;
  if (deps.isDirty(worktree)) {
    deps.log(`worktree ${worktree} has uncommitted changes; leaving its lock alone for the ${kind} fixer on PR #${prNumber}`);
    return false;
  }
  const doc = {
    v: 2,
    cwd: worktree,
    ts: deps.now(),
    claim: { by: OWNER, kind, pr: prNumber, previous: raw },
    worker: { name: `pr-${prNumber}-${kind}` },
    turn: {},
  };
  deps.write(path, JSON.stringify(doc));
  return true;
}

// Put back whatever lock the worktree had before the fixer claimed it. Only
// touches a lock this module wrote.
export function releaseWorktreeFromFixer(worktree: string, deps: LockDeps): void {
  const path = join(worktree, LOCK_NAME);
  const raw = deps.read(path);
  if (!isFixerLock(raw)) return;
  const previous = parse(raw)?.claim?.previous ?? null;
  if (previous === null) deps.remove(path);
  else deps.write(path, previous);
}

export const fsLockDeps = (log: (msg: string) => void): LockDeps => ({
  read: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
  write: (p, c) => writeFileSync(p, c),
  remove: (p) => {
    try {
      unlinkSync(p);
    } catch {
      /* already gone */
    }
  },
  isDirty: (worktree) => {
    try {
      return worktreeIsDirty(execFileSync("git", ["-C", worktree, "status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    } catch {
      return true;
    }
  },
  now: Date.now,
  log,
});
