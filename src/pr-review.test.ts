import assert from "node:assert/strict";
import { test } from "node:test";
import type { OpenPR, UnresolvedInfo } from "./gh.ts";
import { fixSessionName, freshReviewState, type PrReviewDeps, reviewOnce } from "./pr-review.ts";

function pr(number: number, overrides: Partial<OpenPR> = {}): OpenPR {
  return { number, headRefName: `eng-${number}-x`, isDraft: false, ...overrides };
}

function info(count: number, newestOtherCommentAt: number | null): UnresolvedInfo {
  return { count, newestOtherCommentAt };
}

function deps(overrides: Partial<PrReviewDeps> = {}): {
  deps: PrReviewDeps;
  spawned: { name: string; branch: string }[];
  logs: string[];
} {
  const spawned: { name: string; branch: string }[] = [];
  const logs: string[] = [];
  const d: PrReviewDeps = {
    listOpenPRs: async () => [pr(4706)],
    unresolvedInfo: async () => info(2, 1000),
    fixInFlight: () => false,
    spawnFix: (name, branch) => void spawned.push({ name, branch }),
    log: (m) => void logs.push(m),
    ...overrides,
  };
  return { deps: d, spawned, logs };
}

test("fixSessionName is keyed by PR number", () => {
  assert.equal(fixSessionName(4706), "pr-4706-fix");
});

test("reviewOnce spawns a fix for a PR with a new other-authored comment", async () => {
  const { deps: d, spawned } = deps();
  await reviewOnce(freshReviewState(), d);
  assert.deepEqual(spawned, [{ name: "pr-4706-fix", branch: "eng-4706-x" }]);
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
  const { deps: d, spawned } = deps({ fixInFlight: (n) => n === 4706 });
  await reviewOnce(freshReviewState(), d);
  assert.equal(spawned.length, 0);
});
