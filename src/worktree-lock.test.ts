import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claimWorktreeForFixer,
  isFixerLock,
  releaseWorktreeFromFixer,
  worktreeIsDirty,
  type LockDeps,
} from "./worktree-lock.ts";

const WT = "/wt/eng-1-x";
const FLAT = JSON.stringify({ session: "abc", transcript: "/t.jsonl", ts: "2026-11-18T11:00:00Z" });

function fake(initial: string | null, dirty = false) {
  const files = new Map<string, string>();
  if (initial !== null) files.set(`${WT}/.worktree-lock`, initial);
  const logs: string[] = [];
  const deps: LockDeps = {
    read: (p) => files.get(p) ?? null,
    write: (p, c) => void files.set(p, c),
    remove: (p) => void files.delete(p),
    isDirty: () => dirty,
    now: () => 1_000,
    log: (m) => void logs.push(m),
  };
  return { deps, files, logs, lock: () => files.get(`${WT}/.worktree-lock`) };
}

test("claiming writes a v2 document the lock hook defers to", () => {
  const f = fake(FLAT);
  assert.equal(claimWorktreeForFixer(WT, "blocked", 8090, f.deps), true);
  const doc = JSON.parse(f.lock() as string);
  assert.equal(doc.v, 2);
  assert.equal(doc.cwd, WT);
  assert.ok(doc.claim && doc.worker && doc.turn);
  assert.equal("session" in doc, false);
  assert.equal(isFixerLock(f.lock() as string), true);
});

test("releasing restores the previous ticket-session lock byte for byte", () => {
  const f = fake(FLAT);
  claimWorktreeForFixer(WT, "ci", 1, f.deps);
  releaseWorktreeFromFixer(WT, f.deps);
  assert.equal(f.lock(), FLAT);
});

test("releasing removes the lock when there was none before", () => {
  const f = fake(null);
  claimWorktreeForFixer(WT, "fix", 1, f.deps);
  assert.ok(f.lock());
  releaseWorktreeFromFixer(WT, f.deps);
  assert.equal(f.lock(), undefined);
});

test("a dirty worktree is left alone and logged", () => {
  const f = fake(FLAT, true);
  assert.equal(claimWorktreeForFixer(WT, "conflict", 7, f.deps), false);
  assert.equal(f.lock(), FLAT);
  assert.match(f.logs.join("\n"), /uncommitted changes/);
});

test("an orchestrator-owned v2 lock is never claimed or released", () => {
  const orch = JSON.stringify({ v: 2, cwd: WT, ts: 1, claim: { by: "slot-machine" }, worker: {}, turn: {} });
  const f = fake(orch);
  assert.equal(claimWorktreeForFixer(WT, "ci", 1, f.deps), false);
  releaseWorktreeFromFixer(WT, f.deps);
  assert.equal(f.lock(), orch);
});

test("releasing a worktree we never claimed does nothing", () => {
  const f = fake(FLAT);
  releaseWorktreeFromFixer(WT, f.deps);
  assert.equal(f.lock(), FLAT);
});

test("claiming twice keeps the original previous lock", () => {
  const f = fake(FLAT);
  claimWorktreeForFixer(WT, "ci", 1, f.deps);
  claimWorktreeForFixer(WT, "ci", 1, f.deps);
  releaseWorktreeFromFixer(WT, f.deps);
  assert.equal(f.lock(), FLAT);
});

test("worktreeIsDirty ignores the lock file itself", () => {
  assert.equal(worktreeIsDirty("?? .worktree-lock\n"), false);
  assert.equal(worktreeIsDirty(" M src/a.ts\n"), true);
  assert.equal(worktreeIsDirty(""), false);
  assert.equal(worktreeIsDirty(null), true);
});
