import { test } from "node:test";
import assert from "node:assert/strict";
import { masterFindingsEvent, masterMergedEvent, masterMergeOnce, type MasterMergeDeps } from "./master-merge.ts";
import type { MasterMergeEntry } from "./master-merge-state.ts";
import { MAX_DIFF_CHARS } from "./master-review.ts";
import type { ChecksInfo, MergeableInfo, PrState, UnresolvedInfo, YimbotPr } from "./gh.ts";

const CLEAN = '{"clean": true, "findings": []}';
const DIRTY = '{"clean": false, "findings": ["off by one"]}';

function pr(number: number, over: Partial<YimbotPr> = {}): YimbotPr {
  return { number, headRefName: `feat/pr-${number}`, isDraft: false, author: "bot", headSha: `sha${number}`, ...over };
}

function setup(prs: YimbotPr[], over: Partial<MasterMergeDeps> = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  let state: Record<string, MasterMergeEntry> = {};
  let reviewOut = CLEAN;
  const shaOf = (n: number) => prs.find((p) => p.number === n)?.headSha ?? "";
  const deps: MasterMergeDeps = {
    enabled: () => true,
    authors: new Set(["bot"]),
    listPrs: async () => prs,
    checks: async (n): Promise<ChecksInfo> => ({ state: "passing", headSha: shaOf(n) }),
    mergeable: async (n): Promise<MergeableInfo> => ({ state: "mergeable", headSha: shaOf(n) }),
    unresolved: async (): Promise<UnresolvedInfo> => ({
      count: 0,
      newestOtherCommentAt: null,
      newestTrustedCommentAt: null,
      newestHumanCommentAt: null,
    }),
    prState: async (): Promise<PrState> => ({ labels: [], isDraft: false, approved: false, changesRequested: false }),
    diff: async (n) => `diff for ${n}`,
    review: async () => {
      calls.push("review");
      return reviewOut;
    },
    comment: async (n, body) => {
      calls.push(`comment:${n}:${body.includes("off by one")}`);
    },
    markReady: async (n) => {
      calls.push(`ready:${n}`);
    },
    merge: async (n, sha) => {
      calls.push(`merge:${n}:${sha}`);
    },
    loadState: () => structuredClone(state),
    saveState: (s) => {
      state = structuredClone(s);
    },
    onMerged: (p) => calls.push(`merged:${p.number}`),
    onFindings: (p, f) => calls.push(`findings:${p.number}:${f.join("|")}`),
    log: (m) => logs.push(m),
    ...over,
  };
  return {
    deps,
    calls,
    logs,
    state: () => state,
    setState: (s: Record<string, MasterMergeEntry>) => {
      state = s;
    },
    setReview: (out: string) => {
      reviewOut = out;
    },
  };
}

test("does nothing when disabled", async () => {
  let listed = false;
  const h = setup([pr(1)], {
    enabled: () => false,
    listPrs: async () => {
      listed = true;
      return [];
    },
  });
  await masterMergeOnce(h.deps);
  assert.equal(listed, false);
  assert.deepEqual(h.calls, []);
});

test("skips PRs whose author is not trusted", async () => {
  const h = setup([pr(1, { author: "stranger" })]);
  await masterMergeOnce(h.deps);
  assert.deepEqual(h.calls, []);
});

test("clean PR is reviewed and merged with the reviewed sha", async () => {
  const h = setup([pr(1)]);
  await masterMergeOnce(h.deps);
  assert.deepEqual(h.calls, ["review", "merge:1:sha1", "merged:1"]);
  assert.deepEqual(h.state()["1"], { sha: "sha1", clean: true, commented: false, attempts: 1 });
});

const gateFailures: [string, Partial<MasterMergeDeps>][] = [
  ["ci failing", { checks: async () => ({ state: "failing", headSha: "sha1" }) }],
  ["ci pending", { checks: async () => ({ state: "pending", headSha: "sha1" }) }],
  ["ci none", { checks: async () => ({ state: "none", headSha: "sha1" }) }],
  ["checks sha mismatch", { checks: async () => ({ state: "passing", headSha: "other" }) }],
  ["mergeable sha mismatch", { mergeable: async () => ({ state: "mergeable", headSha: "other" }) }],
  ["conflicting", { mergeable: async () => ({ state: "conflicting", headSha: "sha1" }) }],
  ["mergeable unknown", { mergeable: async () => ({ state: "unknown", headSha: "sha1" }) }],
  [
    "unresolved threads",
    {
      unresolved: async () => ({
        count: 2,
        newestOtherCommentAt: null,
        newestTrustedCommentAt: null,
        newestHumanCommentAt: null,
      }),
    },
  ],
  [
    "changes requested",
    { prState: async () => ({ labels: [], isDraft: false, approved: false, changesRequested: true }) },
  ],
  [
    "checks lookup throws",
    {
      checks: async () => {
        throw new Error("boom");
      },
    },
  ],
  [
    "prState lookup throws",
    {
      prState: async () => {
        throw new Error("boom");
      },
    },
  ],
];

for (const [name, over] of gateFailures) {
  test(`gate blocks review and merge: ${name}`, async () => {
    const h = setup([pr(1)], over);
    await masterMergeOnce(h.deps);
    assert.deepEqual(h.calls, []);
    assert.ok(h.logs.length > 0);
  });
}

test("a thrown lookup on one PR does not stop the others", async () => {
  const h = setup([pr(1), pr(2)], {
    checks: async (n) => {
      if (n === 1) throw new Error("boom");
      return { state: "passing", headSha: `sha${n}` };
    },
  });
  await masterMergeOnce(h.deps);
  assert.deepEqual(h.calls, ["review", "merge:2:sha2", "merged:2"]);
});

test("head moving during the diff fetch skips the review", async () => {
  let checksCalls = 0;
  const h = setup([pr(1)], {
    checks: async () => {
      checksCalls++;
      return { state: "passing", headSha: checksCalls === 1 ? "sha1" : "sha1b" };
    },
  });
  await masterMergeOnce(h.deps);
  assert.deepEqual(h.calls, []);
});

test("cached clean verdict for the same sha is not reviewed again", async () => {
  const h = setup([pr(1)], {
    merge: async () => {
      throw new Error("not mergeable yet");
    },
  });
  h.setState({ "1": { sha: "sha1", clean: true, commented: false, attempts: 1 } });
  await masterMergeOnce(h.deps);
  assert.deepEqual(h.calls, []);
  assert.ok(h.logs.some((l) => l.includes("not mergeable yet")));
});

test("a rejecting merge does not throw and is retried next tick", async () => {
  let rejects = true;
  const calls: string[] = [];
  const h = setup([pr(1)], {
    merge: async (n, sha) => {
      calls.push(`merge:${n}:${sha}`);
      if (rejects) throw new Error("rejected");
    },
  });
  await masterMergeOnce(h.deps);
  rejects = false;
  await masterMergeOnce(h.deps);
  assert.deepEqual(calls, ["merge:1:sha1", "merge:1:sha1"]);
  assert.deepEqual(h.calls, ["review", "merged:1"]);
});

test("a new head sha replaces the cached entry and triggers a fresh review", async () => {
  const h = setup([pr(1, { headSha: "sha1new" })]);
  h.setState({ "1": { sha: "sha1", clean: false, commented: true, attempts: 3 } });
  await masterMergeOnce(h.deps);
  assert.deepEqual(h.calls, ["review", "merge:1:sha1new", "merged:1"]);
  assert.deepEqual(h.state()["1"], { sha: "sha1new", clean: true, commented: false, attempts: 1 });
});

test("an oversized diff is never sent to review", async () => {
  const h = setup([pr(1)], { diff: async () => "x".repeat(MAX_DIFF_CHARS + 1) });
  await masterMergeOnce(h.deps);
  assert.deepEqual(h.calls, []);
  assert.ok(h.logs.some((l) => l.includes("too large")));
});

test("junk review output counts attempts and stops after three", async () => {
  const h = setup([pr(1)]);
  h.setReview("no json here");
  for (let i = 0; i < 4; i++) await masterMergeOnce(h.deps);
  assert.deepEqual(h.calls, ["review", "review", "review"]);
  assert.deepEqual(h.state()["1"], { sha: "sha1", clean: false, commented: false, attempts: 3 });
});

test("a throwing review run counts an attempt", async () => {
  const h = setup([pr(1)], {
    review: async () => {
      throw new Error("claude crashed");
    },
  });
  await masterMergeOnce(h.deps);
  assert.equal(h.state()["1"].attempts, 1);
});

test("findings are commented once across two ticks and never merged", async () => {
  const h = setup([pr(1)]);
  h.setReview(DIRTY);
  await masterMergeOnce(h.deps);
  await masterMergeOnce(h.deps);
  assert.deepEqual(h.calls, ["review", "comment:1:true", "findings:1:off by one"]);
  assert.deepEqual(h.state()["1"], { sha: "sha1", clean: false, commented: true, attempts: 1 });
});

test("clean draft is marked ready before merge", async () => {
  const h = setup([pr(1, { isDraft: true })]);
  await masterMergeOnce(h.deps);
  assert.deepEqual(h.calls, ["review", "ready:1", "merge:1:sha1", "merged:1"]);
});

test("only the first of two clean PRs merges in one tick", async () => {
  const h = setup([pr(1), pr(2)]);
  await masterMergeOnce(h.deps);
  assert.deepEqual(h.calls, ["review", "merge:1:sha1", "merged:1"]);
});

test("state is pruned of PRs no longer open", async () => {
  const h = setup([pr(1, { author: "stranger" })]);
  h.setState({
    "1": { sha: "sha1", clean: true, commented: false, attempts: 1 },
    "9": { sha: "sha9", clean: true, commented: false, attempts: 1 },
  });
  await masterMergeOnce(h.deps);
  assert.deepEqual(Object.keys(h.state()), ["1"]);
});

test("a failing findings comment counts an attempt and retries the review", async () => {
  let fail = true;
  const h = setup([pr(1)], {
    comment: async () => {
      if (fail) throw new Error("gh down");
    },
  });
  h.setReview(DIRTY);
  await masterMergeOnce(h.deps);
  assert.deepEqual(h.state()["1"], { sha: "sha1", clean: false, commented: false, attempts: 1 });
  fail = false;
  await masterMergeOnce(h.deps);
  assert.deepEqual(h.state()["1"], { sha: "sha1", clean: false, commented: true, attempts: 2 });
  assert.deepEqual(h.calls, ["review", "review", "findings:1:off by one"]);
});

const postReviewGateFailures: [string, (blocked: () => boolean) => Partial<MasterMergeDeps>][] = [
  [
    "unresolved thread",
    (blocked) => ({
      unresolved: async () => ({
        count: blocked() ? 1 : 0,
        newestOtherCommentAt: null,
        newestTrustedCommentAt: null,
        newestHumanCommentAt: null,
      }),
    }),
  ],
  [
    "changes requested",
    (blocked) => ({
      prState: async () => ({ labels: [], isDraft: true, approved: false, changesRequested: blocked() }),
    }),
  ],
  [
    "CI no longer passing",
    (blocked) => ({
      checks: async () => ({ state: blocked() ? "pending" : "passing", headSha: "sha1" }),
    }),
  ],
];

for (const [name, makeOver] of postReviewGateFailures) {
  test(`gates are rechecked after a clean review: ${name}`, async () => {
    let reviewed = false;
    let ticks = 0;
    const blocked = () => reviewed && ticks === 1;
    const h = setup([pr(1, { isDraft: true })], makeOver(blocked));
    const review = h.deps.review;
    h.deps.review = async (p) => {
      reviewed = true;
      return review(p);
    };
    ticks = 1;
    await masterMergeOnce(h.deps);
    assert.deepEqual(h.calls, ["review"]);
    assert.deepEqual(h.state()["1"], { sha: "sha1", clean: true, commented: false, attempts: 1 });
    ticks = 2;
    await masterMergeOnce(h.deps);
    assert.deepEqual(h.calls, ["review", "ready:1", "merge:1:sha1", "merged:1"]);
  });
}

test("a throwing onMerged still ends the tick after one merge", async () => {
  const h = setup([pr(1), pr(2)], {
    onMerged: () => {
      throw new Error("event log down");
    },
  });
  await masterMergeOnce(h.deps);
  assert.deepEqual(h.calls, ["review", "merge:1:sha1"]);
  assert.ok(h.logs.some((l) => l.includes("event log down")));
});

test("a throwing onFindings does not re-review or re-comment next tick", async () => {
  const h = setup([pr(1)], {
    onFindings: () => {
      throw new Error("event log down");
    },
  });
  h.setReview(DIRTY);
  await masterMergeOnce(h.deps);
  await masterMergeOnce(h.deps);
  assert.deepEqual(h.calls, ["review", "comment:1:true"]);
  assert.deepEqual(h.state()["1"], { sha: "sha1", clean: false, commented: true, attempts: 1 });
});

test("master merge events key on the yimbot PR and carry no pr field", () => {
  const merged = masterMergedEvent(pr(7));
  assert.deepEqual(merged, { kind: "master_merged", key: "yimbot-pr:7", label: "yimbot PR #7", title: "feat/pr-7" });
  const findings = masterFindingsEvent(pr(8), ["a", "b"]);
  assert.deepEqual(findings, { kind: "master_review_findings", key: "yimbot-pr:8", label: "yimbot PR #8", title: "2 findings" });
  assert.equal(masterFindingsEvent(pr(9), ["a"]).title, "1 finding");
  assert.equal("pr" in merged, false);
});
