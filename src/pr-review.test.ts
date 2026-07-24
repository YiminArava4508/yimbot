import assert from "node:assert/strict";
import { test } from "node:test";
import type { OpenPR } from "./gh.ts";
import { fixSessionName, freshReviewState, type PrReviewDeps, type ReviewState, reviewOnce, SPAWN_GRACE_MS } from "./pr-review.ts";

function pr(number: number, overrides: Partial<OpenPR> = {}): OpenPR {
  return { number, headRefName: `eng-${number}-x`, isDraft: false, ...overrides };
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
    unresolvedCount: async () => 2,
    fixInFlight: () => false,
    spawnFix: (name, branch) => void spawned.push({ name, branch }),
    now: () => 0,
    log: (m) => void logs.push(m),
    ...overrides,
  };
  return { deps: d, spawned, logs };
}

test("fixSessionName is keyed by PR number", () => {
  assert.equal(fixSessionName(4706), "pr-4706-fix");
});

test("reviewOnce spawns a fix session for a PR with unresolved comments", async () => {
  const { deps: d, spawned } = deps();
  await reviewOnce(freshReviewState(), d);
  assert.deepEqual(spawned, [{ name: "pr-4706-fix", branch: "eng-4706-x" }]);
});

test("reviewOnce skips draft PRs", async () => {
  const { deps: d, spawned } = deps({ listOpenPRs: async () => [pr(1, { isDraft: true })] });
  await reviewOnce(freshReviewState(), d);
  assert.equal(spawned.length, 0);
});

test("reviewOnce skips a PR with no unresolved threads", async () => {
  const { deps: d, spawned } = deps({ unresolvedCount: async () => 0 });
  await reviewOnce(freshReviewState(), d);
  assert.equal(spawned.length, 0);
});

test("reviewOnce skips a PR whose fix is already in flight (in-flight guard)", async () => {
  let counted = false;
  const seen: { number: number; branch: string }[] = [];
  const { deps: d, spawned } = deps({
    fixInFlight: (number, branch) => {
      seen.push({ number, branch });
      return number === 4706;
    },
    unresolvedCount: async () => {
      counted = true;
      return 5;
    },
  });
  await reviewOnce(freshReviewState(), d);
  assert.equal(spawned.length, 0);
  assert.equal(counted, false, "must not even count threads when a fix is in flight");
  assert.deepEqual(seen, [{ number: 4706, branch: "eng-4706-x" }], "guard gets PR number and branch");
});

test("reviewOnce does not re-spawn within the grace window (no visible session yet)", async () => {
  let clock = 0;
  const spawned: string[] = [];
  const state: ReviewState = freshReviewState();
  const { deps: base } = deps();
  const d: PrReviewDeps = {
    ...base,
    fixInFlight: () => false, // session not yet visible to the guard
    now: () => clock,
    spawnFix: (name) => void spawned.push(name),
  };

  await reviewOnce(state, d); // spawns at t=0
  clock = SPAWN_GRACE_MS - 1;
  await reviewOnce(state, d); // still within grace: no second spawn
  assert.deepEqual(spawned, ["pr-4706-fix"]);
});

test("reviewOnce re-spawns after the grace window elapses (retry a lost spawn)", async () => {
  let clock = 0;
  const spawned: string[] = [];
  const state: ReviewState = freshReviewState();
  const { deps: base } = deps();
  const d: PrReviewDeps = {
    ...base,
    fixInFlight: () => false,
    now: () => clock,
    spawnFix: (name) => void spawned.push(name),
  };

  await reviewOnce(state, d); // t=0
  clock = SPAWN_GRACE_MS; // grace elapsed
  await reviewOnce(state, d);
  assert.deepEqual(spawned, ["pr-4706-fix", "pr-4706-fix"]);
});

test("reviewOnce continues to other PRs when one PR's thread count throws", async () => {
  const { deps: d, spawned, logs } = deps({
    listOpenPRs: async () => [pr(1), pr(2)],
    unresolvedCount: async (n) => {
      if (n === 1) throw new Error("graphql 502");
      return 3;
    },
  });
  await reviewOnce(freshReviewState(), d);
  assert.deepEqual(spawned.map((s) => s.name), ["pr-2-fix"]);
  assert.ok(logs.some((l) => /graphql 502/.test(l)));
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
