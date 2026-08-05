import assert from "node:assert/strict";
import { test } from "node:test";
import type { BlockedInfo, ChecksInfo, CiState, MergeableInfo, MergeableState, OpenPR, UnresolvedInfo } from "./gh.ts";
import {
  blockedSessionName,
  ciSessionName,
  conflictSessionName,
  type FixKind,
  fixSessionName,
  fixSessionNames,
  freshReviewState,
  type PrReviewDeps,
  reviewOnce,
} from "./pr-review.ts";

function pr(number: number, overrides: Partial<OpenPR> = {}): OpenPR {
  return { number, headRefName: `eng-${number}-x`, isDraft: false, ...overrides };
}

function info(count: number, newestOtherCommentAt: number | null): UnresolvedInfo {
  return { count, newestOtherCommentAt };
}

const noComments = info(0, null);
function ci(state: CiState, headSha = "sha"): ChecksInfo {
  return { state, headSha };
}
function merge(state: MergeableState, headSha = "sha"): MergeableInfo {
  return { state, headSha };
}
const noConflict = merge("mergeable");

function deps(overrides: Partial<PrReviewDeps> = {}): {
  deps: PrReviewDeps;
  spawned: { name: string; branch: string; prNumber: number }[];
  ciSpawned: { name: string; branch: string; prNumber: number }[];
  conflictSpawned: { name: string; branch: string; prNumber: number }[];
  blockedSpawned: { name: string; branch: string; prNumber: number }[];
  reaped: { prNumber: number; branch: string; kind: string }[];
  logs: string[];
} {
  const spawned: { name: string; branch: string; prNumber: number }[] = [];
  const ciSpawned: { name: string; branch: string; prNumber: number }[] = [];
  const conflictSpawned: { name: string; branch: string; prNumber: number }[] = [];
  const blockedSpawned: { name: string; branch: string; prNumber: number }[] = [];
  const reaped: { prNumber: number; branch: string; kind: string }[] = [];
  const logs: string[] = [];
  const d: PrReviewDeps = {
    listOpenPRs: async () => [pr(4706)],
    unresolvedInfo: async () => info(2, 1000),
    mergeableInfo: async () => noConflict,
    checksInfo: async () => ci("passing"),
    blockedInfo: async () => ({ blocked: false, headSha: "sha" }),
    inFlightFixKinds: () => [],
    reapFix: (prNumber, branch, kind) => void reaped.push({ prNumber, branch, kind }),
    now: () => 0,
    reapStaleMs: 90 * 60 * 1000,
    spawnFix: (name, branch, prNumber) => void spawned.push({ name, branch, prNumber }),
    spawnCiFix: (name, branch, prNumber) => void ciSpawned.push({ name, branch, prNumber }),
    spawnConflictFix: (name, branch, prNumber) => void conflictSpawned.push({ name, branch, prNumber }),
    spawnBlockedFix: (name, branch, prNumber) => void blockedSpawned.push({ name, branch, prNumber }),
    log: (m) => void logs.push(m),
    ...overrides,
  };
  return { deps: d, spawned, ciSpawned, conflictSpawned, blockedSpawned, reaped, logs };
}

test("fixSessionName is keyed by PR number", () => {
  assert.equal(fixSessionName(4706), "pr-4706-fix");
});

test("ciSessionName is keyed by PR number", () => {
  assert.equal(ciSessionName(4706), "pr-4706-ci");
});

test("reviewOnce spawns a CI fix for a PR with failing CI and no comments", async () => {
  const { deps: d, ciSpawned } = deps({ unresolvedInfo: async () => noComments, checksInfo: async () => ci("failing", "abc") });
  const state = freshReviewState();
  await reviewOnce(state, d);
  assert.deepEqual(ciSpawned, [{ name: "pr-4706-ci", branch: "eng-4706-x", prNumber: 4706 }]);
  assert.equal(state.lastHandledCiSha.get(4706), "abc");
});

test("reviewOnce does not spawn a CI fix for passing/pending/none CI", async () => {
  for (const state of ["passing", "pending", "none"] as CiState[]) {
    const { deps: d, ciSpawned } = deps({ unresolvedInfo: async () => noComments, checksInfo: async () => ci(state) });
    await reviewOnce(freshReviewState(), d);
    assert.equal(ciSpawned.length, 0, `${state} must not spawn`);
  }
});

test("reviewOnce does not re-spawn a CI fix for the same failing SHA", async () => {
  const { deps: d, ciSpawned } = deps({ unresolvedInfo: async () => noComments, checksInfo: async () => ci("failing", "abc") });
  const state = freshReviewState();
  await reviewOnce(state, d);
  await reviewOnce(state, d);
  assert.equal(ciSpawned.length, 1);
});

test("reviewOnce re-spawns a CI fix when the failing SHA changes", async () => {
  let sha = "abc";
  const { deps: d, ciSpawned } = deps({ unresolvedInfo: async () => noComments, checksInfo: async () => ci("failing", sha) });
  const state = freshReviewState();
  await reviewOnce(state, d);
  sha = "def"; // a fix push moved the head; still red
  await reviewOnce(state, d);
  assert.equal(ciSpawned.length, 2);
  assert.equal(state.lastHandledCiSha.get(4706), "def");
});

test("reviewOnce prefers the comment fix and skips CI the same tick when both are actionable", async () => {
  const { deps: d, spawned, ciSpawned } = deps({
    unresolvedInfo: async () => info(1, 1000),
    checksInfo: async () => ci("failing", "abc"),
  });
  const state = freshReviewState();
  await reviewOnce(state, d);
  assert.deepEqual(spawned.map((s) => s.name), ["pr-4706-fix"]);
  assert.equal(ciSpawned.length, 0);
  assert.equal(state.lastHandledCiSha.has(4706), false, "CI SHA is not recorded when CI was skipped");
});

test("reviewOnce does not spawn a CI fix while a just-spawned comment fix is not yet visible", async () => {
  // Comment fix spawned tick 1; not yet in flight (session/window starting).
  // The cross-kind latch must suppress the CI spawn onto the shared worktree.
  const { deps: d, spawned, ciSpawned } = deps({
    unresolvedInfo: async () => info(1, 1000),
    checksInfo: async () => ci("failing", "abc"),
  });
  const state = freshReviewState();
  await reviewOnce(state, d); // spawns the comment fix
  await reviewOnce(state, d); // must NOT spawn CI while the comment fix is unobserved
  assert.equal(spawned.length, 1);
  assert.equal(ciSpawned.length, 0);
});

test("reviewOnce spawns the CI fix after the comment fix has been seen live and finished", async () => {
  let inFlight = false;
  const { deps: d, spawned, ciSpawned } = deps({
    unresolvedInfo: async () => info(1, 1000),
    checksInfo: async () => ci("failing", "abc"),
    inFlightFixKinds: () => (inFlight ? ["fix"] : []),
  });
  const state = freshReviewState();
  await reviewOnce(state, d); // tick 1: spawn comment fix (latch = fix)
  inFlight = true;
  await reviewOnce(state, d); // tick 2: comment fix now visible → clears latch, skips
  inFlight = false;
  await reviewOnce(state, d); // tick 3: comment fix gone → CI failing on unhandled sha spawns
  assert.equal(spawned.length, 1);
  assert.deepEqual(ciSpawned.map((s) => s.name), ["pr-4706-ci"]);
});

test("reviewOnce does not spawn a comment fix while a just-spawned CI fix is not yet visible", async () => {
  // Tick 1 has no comment work, so CI wins and its fix is spawned (latch = ci).
  // Tick 2 a comment arrives before the CI fix is visible; it must be suppressed.
  let comments: UnresolvedInfo = noComments;
  const { deps: d, spawned, ciSpawned } = deps({
    unresolvedInfo: async () => comments,
    checksInfo: async () => ci("failing", "abc"),
  });
  const state = freshReviewState();
  await reviewOnce(state, d); // CI-only failure → spawn CI fix (latch = ci)
  comments = info(1, 2000); // a comment now arrives, CI fix not yet visible
  await reviewOnce(state, d); // must NOT spawn the comment fix onto the shared worktree
  assert.equal(ciSpawned.length, 1);
  assert.equal(spawned.length, 0);
});

test("reviewOnce skips CI when a fix is already in flight", async () => {
  const { deps: d, ciSpawned } = deps({
    unresolvedInfo: async () => noComments,
    checksInfo: async () => ci("failing", "abc"),
    inFlightFixKinds: () => ["fix"],
  });
  await reviewOnce(freshReviewState(), d);
  assert.equal(ciSpawned.length, 0);
});

test("conflictSessionName is keyed by PR number", () => {
  assert.equal(conflictSessionName(4706), "pr-4706-conflict");
});

test("fixSessionNames lists every fix session kind for the PR (the in-flight guard set)", () => {
  assert.deepEqual(fixSessionNames(4706), ["pr-4706-fix", "pr-4706-ci", "pr-4706-conflict", "pr-4706-blocked"]);
});

test("reviewOnce spawns a conflict fix for a conflicting PR with no comments and passing CI", async () => {
  const { deps: d, conflictSpawned } = deps({
    unresolvedInfo: async () => noComments,
    mergeableInfo: async () => merge("conflicting", "abc"),
  });
  const state = freshReviewState();
  await reviewOnce(state, d);
  assert.deepEqual(conflictSpawned, [{ name: "pr-4706-conflict", branch: "eng-4706-x", prNumber: 4706 }]);
  assert.equal(state.lastHandledConflictSha.get(4706), "abc");
});

test("reviewOnce does not spawn a conflict fix for mergeable or unknown PRs", async () => {
  for (const s of ["mergeable", "unknown"] as MergeableState[]) {
    const { deps: d, conflictSpawned } = deps({
      unresolvedInfo: async () => noComments,
      mergeableInfo: async () => merge(s),
    });
    await reviewOnce(freshReviewState(), d);
    assert.equal(conflictSpawned.length, 0, `${s} must not spawn`);
  }
});

test("reviewOnce does not re-spawn a conflict fix for the same head SHA", async () => {
  const { deps: d, conflictSpawned } = deps({
    unresolvedInfo: async () => noComments,
    mergeableInfo: async () => merge("conflicting", "abc"),
  });
  const state = freshReviewState();
  await reviewOnce(state, d);
  await reviewOnce(state, d);
  assert.equal(conflictSpawned.length, 1);
});

test("reviewOnce re-spawns a conflict fix when the head SHA moves", async () => {
  let sha = "abc";
  const { deps: d, conflictSpawned } = deps({
    unresolvedInfo: async () => noComments,
    mergeableInfo: async () => merge("conflicting", sha),
  });
  const state = freshReviewState();
  await reviewOnce(state, d);
  sha = "def"; // a human pushed; still conflicting on the new head
  await reviewOnce(state, d);
  assert.equal(conflictSpawned.length, 2);
  assert.equal(state.lastHandledConflictSha.get(4706), "def");
});

test("reviewOnce prefers the comment fix and skips the conflict fix the same tick", async () => {
  const { deps: d, spawned, conflictSpawned } = deps({
    unresolvedInfo: async () => info(1, 1000),
    mergeableInfo: async () => merge("conflicting", "abc"),
  });
  const state = freshReviewState();
  await reviewOnce(state, d);
  assert.deepEqual(spawned.map((s) => s.name), ["pr-4706-fix"]);
  assert.equal(conflictSpawned.length, 0);
  assert.equal(state.lastHandledConflictSha.has(4706), false, "conflict SHA is not recorded when it was skipped");
});

test("reviewOnce prefers the conflict fix over the CI fix the same tick", async () => {
  const { deps: d, conflictSpawned, ciSpawned } = deps({
    unresolvedInfo: async () => noComments,
    mergeableInfo: async () => merge("conflicting", "abc"),
    checksInfo: async () => ci("failing", "abc"),
  });
  const state = freshReviewState();
  await reviewOnce(state, d);
  assert.deepEqual(conflictSpawned.map((s) => s.name), ["pr-4706-conflict"]);
  assert.equal(ciSpawned.length, 0);
  assert.equal(state.lastHandledCiSha.has(4706), false, "CI SHA is not recorded when CI was skipped");
});

test("reviewOnce does not spawn a CI fix while a just-spawned conflict fix is not yet visible", async () => {
  const { deps: d, conflictSpawned, ciSpawned } = deps({
    unresolvedInfo: async () => noComments,
    mergeableInfo: async () => merge("conflicting", "abc"),
    checksInfo: async () => ci("failing", "def"),
  });
  const state = freshReviewState();
  await reviewOnce(state, d); // spawns the conflict fix (latch = conflict)
  await reviewOnce(state, d); // must NOT spawn CI while the conflict fix is unobserved
  assert.equal(conflictSpawned.length, 1);
  assert.equal(ciSpawned.length, 0);
});

test("reviewOnce does not spawn a comment fix while a just-spawned conflict fix is not yet visible", async () => {
  let comments: UnresolvedInfo = noComments;
  const { deps: d, spawned, conflictSpawned } = deps({
    unresolvedInfo: async () => comments,
    mergeableInfo: async () => merge("conflicting", "abc"),
  });
  const state = freshReviewState();
  await reviewOnce(state, d); // conflict-only → spawn conflict fix (latch = conflict)
  comments = info(1, 2000); // a comment now arrives, conflict fix not yet visible
  await reviewOnce(state, d); // must NOT spawn the comment fix onto the shared worktree
  assert.equal(conflictSpawned.length, 1);
  assert.equal(spawned.length, 0);
});

test("reviewOnce skips a conflict fix when a fix is already in flight", async () => {
  const { deps: d, conflictSpawned } = deps({
    unresolvedInfo: async () => noComments,
    mergeableInfo: async () => merge("conflicting", "abc"),
    inFlightFixKinds: () => ["fix"],
  });
  await reviewOnce(freshReviewState(), d);
  assert.equal(conflictSpawned.length, 0);
});

test("reviewOnce continues to the next PR when one PR's mergeable info throws", async () => {
  const { deps: d, conflictSpawned, logs } = deps({
    listOpenPRs: async () => [pr(1), pr(2)],
    unresolvedInfo: async () => noComments,
    mergeableInfo: async (n) => {
      if (n === 1) throw new Error("gh mergeable 502");
      return merge("conflicting", "abc");
    },
  });
  await reviewOnce(freshReviewState(), d);
  assert.deepEqual(conflictSpawned.map((s) => s.name), ["pr-2-conflict"]);
  assert.ok(logs.some((l) => /gh mergeable 502/.test(l)));
});

test("reviewOnce spawns a fix for a PR with a new other-authored comment", async () => {
  const { deps: d, spawned } = deps();
  await reviewOnce(freshReviewState(), d);
  assert.deepEqual(spawned, [{ name: "pr-4706-fix", branch: "eng-4706-x", prNumber: 4706 }]);
});

test("reviewOnce records the handled timestamp so the same round does not re-spawn", async () => {
  const { deps: d, spawned } = deps();
  const state = freshReviewState();
  await reviewOnce(state, d);
  await reviewOnce(state, d); // same newestOtherCommentAt=1000
  assert.equal(spawned.length, 1);
  assert.equal(state.lastHandledAt.get(4706), 1000);
});

test("reviewOnce re-spawns when a newer comment arrives", async () => {
  let ts = 1000;
  const { deps: d, spawned } = deps({ unresolvedInfo: async () => info(1, ts) });
  const state = freshReviewState();
  await reviewOnce(state, d); // handles 1000
  ts = 2000; // new comment
  await reviewOnce(state, d); // handles 2000
  assert.equal(spawned.length, 2);
  assert.equal(state.lastHandledAt.get(4706), 2000);
});

test("reviewOnce does not loop on deliberately-left threads (older timestamp)", async () => {
  const { deps: d, spawned } = deps({ unresolvedInfo: async () => info(3, 1000) });
  const state = freshReviewState();
  state.lastHandledAt.set(4706, 1000); // already handled up to here
  await reviewOnce(state, d);
  assert.equal(spawned.length, 0);
});

test("reviewOnce skips when only the viewer's own replies remain (null timestamp)", async () => {
  const { deps: d, spawned } = deps({ unresolvedInfo: async () => info(2, null) });
  await reviewOnce(freshReviewState(), d);
  assert.equal(spawned.length, 0);
});

test("reviewOnce skips draft PRs", async () => {
  const { deps: d, spawned } = deps({ listOpenPRs: async () => [pr(1, { isDraft: true })] });
  await reviewOnce(freshReviewState(), d);
  assert.equal(spawned.length, 0);
});

test("reviewOnce skips a PR with no unresolved threads", async () => {
  const { deps: d, spawned } = deps({ unresolvedInfo: async () => info(0, null) });
  await reviewOnce(freshReviewState(), d);
  assert.equal(spawned.length, 0);
});

test("reviewOnce skips a PR whose fix is already in flight", async () => {
  const { deps: d, spawned } = deps({ inFlightFixKinds: (n) => (n === 4706 ? ["fix"] : []) });
  await reviewOnce(freshReviewState(), d);
  assert.equal(spawned.length, 0);
});

test("reviewOnce swallows a listOpenPRs failure without throwing or spawning", async () => {
  const { deps: d, spawned, logs } = deps({
    listOpenPRs: async () => {
      throw new Error("gh 500");
    },
  });
  await reviewOnce(freshReviewState(), d); // must not throw
  assert.equal(spawned.length, 0);
  assert.ok(logs.some((l) => /gh 500/.test(l)));
});

test("reviewOnce continues to the next PR when one PR's thread info throws", async () => {
  const { deps: d, spawned, logs } = deps({
    listOpenPRs: async () => [pr(1), pr(2)],
    unresolvedInfo: async (n) => {
      if (n === 1) throw new Error("graphql 502");
      return info(1, 1000);
    },
  });
  await reviewOnce(freshReviewState(), d);
  assert.deepEqual(spawned.map((s) => s.name), ["pr-2-fix"]);
  assert.ok(logs.some((l) => /graphql 502/.test(l)));
});

test("reviewOnce reaps a conflict fix once the PR is mergeable", async () => {
  const { deps: d, reaped } = deps({
    inFlightFixKinds: () => ["conflict"],
    mergeableInfo: async () => merge("mergeable", "abc"),
  });
  await reviewOnce(freshReviewState(), d);
  assert.deepEqual(reaped, [{ prNumber: 4706, branch: "eng-4706-x", kind: "conflict" }]);
});

test("reviewOnce does not reap a conflict fix while still conflicting or unknown", async () => {
  for (const state of ["conflicting", "unknown"] as const) {
    const { deps: d, reaped } = deps({
      inFlightFixKinds: () => ["conflict"],
      mergeableInfo: async () => merge(state, "abc"),
    });
    await reviewOnce(freshReviewState(), d);
    assert.equal(reaped.length, 0, `state ${state} must not reap`);
  }
});

test("reviewOnce reaps a CI fix once checks are passing", async () => {
  const { deps: d, reaped } = deps({
    inFlightFixKinds: () => ["ci"],
    checksInfo: async () => ci("passing", "abc"),
  });
  await reviewOnce(freshReviewState(), d);
  assert.deepEqual(reaped.map((r) => r.kind), ["ci"]);
});

test("reviewOnce does not reap a CI fix while failing or pending", async () => {
  for (const state of ["failing", "pending"] as const) {
    const { deps: d, reaped } = deps({
      inFlightFixKinds: () => ["ci"],
      checksInfo: async () => ci(state, "abc"),
    });
    await reviewOnce(freshReviewState(), d);
    assert.equal(reaped.length, 0, `state ${state} must not reap`);
  }
});

test("reviewOnce never objective-reaps a comment fix (backstop only)", async () => {
  const { deps: d, reaped } = deps({ inFlightFixKinds: () => ["fix"] });
  await reviewOnce(freshReviewState(), d); // mergeable + passing by default, but kind is comment
  assert.equal(reaped.length, 0);
});

test("reviewOnce reaps any in-flight fix once it has been in flight past reapStaleMs", async () => {
  let clock = 0;
  const { deps: d, reaped } = deps({
    inFlightFixKinds: () => ["fix"],
    mergeableInfo: async () => merge("conflicting", "abc"), // objective NOT met
    checksInfo: async () => ci("failing", "abc"),
    now: () => clock,
    reapStaleMs: 1000,
  });
  const state = freshReviewState();
  await reviewOnce(state, d); // clock=0: first sighting, timer starts, not stale
  assert.equal(reaped.length, 0);
  clock = 1000; // exactly reapStaleMs later
  await reviewOnce(state, d);
  assert.deepEqual(reaped.map((r) => r.kind), ["fix"]);
});

test("reviewOnce does not reap on the tick a fix is first seen", async () => {
  const { deps: d, reaped } = deps({
    inFlightFixKinds: () => ["fix"],
    now: () => 5_000_000,
    reapStaleMs: 1000,
  });
  await reviewOnce(freshReviewState(), d); // fresh state: firstSeen = now, elapsed 0
  assert.equal(reaped.length, 0);
});

test("reviewOnce does not reap when the objective read throws", async () => {
  const { deps: d, reaped, logs } = deps({
    inFlightFixKinds: () => ["conflict"],
    mergeableInfo: async () => {
      throw new Error("gh mergeable 502");
    },
  });
  await reviewOnce(freshReviewState(), d);
  assert.equal(reaped.length, 0);
  assert.ok(logs.some((l) => /gh mergeable 502/.test(l)));
});

test("reviewOnce reap does not clear the handled-SHA maps (anti-loop preserved)", async () => {
  const { deps: d } = deps({
    inFlightFixKinds: () => ["conflict"],
    mergeableInfo: async () => merge("mergeable", "abc"),
  });
  const state = freshReviewState();
  state.lastHandledConflictSha.set(4706, "old");
  await reviewOnce(state, d);
  assert.equal(state.lastHandledConflictSha.get(4706), "old");
});

test("reviewOnce prunes a fix timer once the kind is no longer in flight", async () => {
  let kinds: FixKind[] = ["fix"];
  const { deps: d } = deps({
    inFlightFixKinds: () => kinds,
    now: () => 0,
    reapStaleMs: 1000,
  });
  const state = freshReviewState();
  await reviewOnce(state, d); // records fixSeenAt "4706:fix" = 0
  assert.equal(state.fixSeenAt.get("4706:fix"), 0);
  kinds = [];
  await reviewOnce(state, d); // no longer in flight -> pruned
  assert.equal(state.fixSeenAt.has("4706:fix"), false);
});

test("blockedSessionName is keyed by PR number", () => {
  assert.equal(blockedSessionName(4929), "pr-4929-blocked");
});

test("reviewOnce spawns a blocked fix for a blocked PR with no comments/conflict/CI work", async () => {
  const { deps: d, blockedSpawned } = deps({
    unresolvedInfo: async () => noComments,
    blockedInfo: async () => ({ blocked: true, headSha: "abc" }),
  });
  const state = freshReviewState();
  await reviewOnce(state, d);
  assert.deepEqual(blockedSpawned, [{ name: "pr-4706-blocked", branch: "eng-4706-x", prNumber: 4706 }]);
  assert.equal(state.lastHandledBlockedSha.get(4706), "abc");
});

test("reviewOnce does not spawn a blocked fix when the PR is not blocked", async () => {
  const { deps: d, blockedSpawned } = deps({
    unresolvedInfo: async () => noComments,
    blockedInfo: async () => ({ blocked: false, headSha: "abc" }),
  });
  await reviewOnce(freshReviewState(), d);
  assert.equal(blockedSpawned.length, 0);
});

test("reviewOnce does not re-spawn a blocked fix for the same blocked SHA", async () => {
  const { deps: d, blockedSpawned } = deps({
    unresolvedInfo: async () => noComments,
    blockedInfo: async () => ({ blocked: true, headSha: "abc" }),
  });
  const state = freshReviewState();
  await reviewOnce(state, d);
  await reviewOnce(state, d);
  assert.equal(blockedSpawned.length, 1);
});

test("reviewOnce re-spawns a blocked fix when the blocked SHA changes", async () => {
  let sha = "abc";
  const { deps: d, blockedSpawned } = deps({
    unresolvedInfo: async () => noComments,
    blockedInfo: async () => ({ blocked: true, headSha: sha }),
  });
  const state = freshReviewState();
  await reviewOnce(state, d);
  sha = "def";
  await reviewOnce(state, d);
  assert.equal(blockedSpawned.length, 2);
});

test("a blocked PR takes precedence over its own failing CI (no CI fix spawned)", async () => {
  const { deps: d, blockedSpawned, ciSpawned } = deps({
    unresolvedInfo: async () => noComments,
    blockedInfo: async () => ({ blocked: true, headSha: "abc" }),
    checksInfo: async () => ci("failing", "abc"),
  });
  await reviewOnce(freshReviewState(), d);
  assert.equal(blockedSpawned.length, 1);
  assert.equal(ciSpawned.length, 0);
});

test("a conflicting blocked PR resolves the conflict first (no blocked fix this tick)", async () => {
  const { deps: d, blockedSpawned, conflictSpawned } = deps({
    unresolvedInfo: async () => noComments,
    mergeableInfo: async () => merge("conflicting", "abc"),
    blockedInfo: async () => ({ blocked: true, headSha: "abc" }),
  });
  await reviewOnce(freshReviewState(), d);
  assert.equal(conflictSpawned.length, 1);
  assert.equal(blockedSpawned.length, 0);
});

test("reviewOnce reaps a blocked fix once the label is gone", async () => {
  const { deps: d, reaped } = deps({
    inFlightFixKinds: () => ["blocked"] as FixKind[],
    blockedInfo: async () => ({ blocked: false, headSha: "abc" }),
  });
  await reviewOnce(freshReviewState(), d);
  assert.deepEqual(reaped, [{ prNumber: 4706, branch: "eng-4706-x", kind: "blocked" }]);
});

test("reviewOnce does not reap a blocked fix while the label remains", async () => {
  const { deps: d, reaped } = deps({
    inFlightFixKinds: () => ["blocked"] as FixKind[],
    blockedInfo: async () => ({ blocked: true, headSha: "abc" }),
  });
  await reviewOnce(freshReviewState(), d);
  assert.equal(reaped.length, 0);
});
