import assert from "node:assert/strict";
import { test } from "node:test";
import type { OpenPR } from "./gh.ts";
import { fixSessionName, type PrReviewDeps, reviewOnce } from "./pr-review.ts";

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
    listOpenPRs: () => [pr(4706)],
    unresolvedCount: () => 2,
    sessionExists: () => false,
    spawnFix: (name, branch) => void spawned.push({ name, branch }),
    log: (m) => void logs.push(m),
    ...overrides,
  };
  return { deps: d, spawned, logs };
}

test("fixSessionName is keyed by PR number", () => {
  assert.equal(fixSessionName(4706), "pr-4706-fix");
});

test("reviewOnce spawns a fix session for a PR with unresolved comments", () => {
  const { deps: d, spawned } = deps();
  reviewOnce(d);
  assert.deepEqual(spawned, [{ name: "pr-4706-fix", branch: "eng-4706-x" }]);
});

test("reviewOnce skips draft PRs", () => {
  const { deps: d, spawned } = deps({ listOpenPRs: () => [pr(1, { isDraft: true })] });
  reviewOnce(d);
  assert.equal(spawned.length, 0);
});

test("reviewOnce skips a PR with no unresolved threads", () => {
  const { deps: d, spawned } = deps({ unresolvedCount: () => 0 });
  reviewOnce(d);
  assert.equal(spawned.length, 0);
});

test("reviewOnce skips a PR whose fix session is already running (in-flight guard)", () => {
  let counted = false;
  const { deps: d, spawned } = deps({
    sessionExists: (name) => name === "pr-4706-fix",
    unresolvedCount: () => {
      counted = true;
      return 5;
    },
  });
  reviewOnce(d);
  assert.equal(spawned.length, 0);
  assert.equal(counted, false, "must not even count threads when a fix session exists");
});

test("reviewOnce continues to other PRs when one PR's thread count throws", () => {
  const { deps: d, spawned, logs } = deps({
    listOpenPRs: () => [pr(1), pr(2)],
    unresolvedCount: (n) => {
      if (n === 1) throw new Error("graphql 502");
      return 3;
    },
  });
  reviewOnce(d);
  assert.deepEqual(spawned.map((s) => s.name), ["pr-2-fix"]);
  assert.ok(logs.some((l) => /graphql 502/.test(l)));
});

test("reviewOnce swallows a listOpenPRs failure without throwing or spawning", () => {
  const { deps: d, spawned, logs } = deps({
    listOpenPRs: () => {
      throw new Error("gh 500");
    },
  });
  reviewOnce(d); // must not throw
  assert.equal(spawned.length, 0);
  assert.ok(logs.some((l) => /gh 500/.test(l)));
});
