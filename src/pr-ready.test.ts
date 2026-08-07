import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChecksInfo, CiState, MergeableInfo, MergeableState, OpenPR, UnresolvedInfo } from "./gh.ts";
import { boardReadyToMerge, type PrReadyDeps, readyOnce } from "./pr-ready.ts";

const LABEL = "ready-to-merge";

function pr(number: number, overrides: Partial<OpenPR> = {}): OpenPR {
  return { number, headRefName: `eng-${number}-x`, isDraft: false, ...overrides };
}
function info(count: number): UnresolvedInfo {
  return { count, newestOtherCommentAt: count > 0 ? 1000 : null };
}
function ci(state: CiState): ChecksInfo {
  return { state, headSha: "sha" };
}
function merge(state: MergeableState): MergeableInfo {
  return { state, headSha: "sha" };
}

type Harness = {
  deps: PrReadyDeps;
  added: { n: number; label: string }[];
  removed: { n: number; label: string }[];
  logs: string[];
  calls: { unresolved: number; mergeable: number; checks: number; labels: number };
};

// A fully-faked readyOnce environment. Defaults describe a single ready PR
// (#4706, no unresolved threads, mergeable, passing CI); `currentLabels` is what
// prLabels reports, and each override swaps in one not-ready signal.
function harness(overrides: Partial<PrReadyDeps> = {}, currentLabels: string[] = []): Harness {
  const added: { n: number; label: string }[] = [];
  const removed: { n: number; label: string }[] = [];
  const logs: string[] = [];
  const calls = { unresolved: 0, mergeable: 0, checks: 0, labels: 0 };
  const deps: PrReadyDeps = {
    listOpenPRs: async () => [pr(4706)],
    unresolvedInfo: async () => {
      calls.unresolved++;
      return info(0);
    },
    mergeableInfo: async () => {
      calls.mergeable++;
      return merge("mergeable");
    },
    checksInfo: async () => {
      calls.checks++;
      return ci("passing");
    },
    prLabels: async () => {
      calls.labels++;
      return currentLabels;
    },
    addLabel: async (n, label) => void added.push({ n, label }),
    removeLabel: async (n, label) => void removed.push({ n, label }),
    label: LABEL,
    blockedLabel: "blocked",
    log: (m) => void logs.push(m),
    ...overrides,
  };
  return { deps, added, removed, logs, calls };
}

test("readyOnce adds the label to a ready PR that lacks it", async () => {
  const h = harness({}, []);
  await readyOnce(h.deps);
  assert.deepEqual(h.added, [{ n: 4706, label: LABEL }]);
  assert.equal(h.removed.length, 0);
});

test("readyOnce does not re-add the label to an already-labeled ready PR", async () => {
  const h = harness({}, [LABEL]);
  await readyOnce(h.deps);
  assert.equal(h.added.length, 0);
  assert.equal(h.removed.length, 0);
});

test("readyOnce removes the label on a hard regression", async () => {
  const cases: Partial<PrReadyDeps>[] = [
    { unresolvedInfo: async () => info(1) },
    { mergeableInfo: async () => merge("conflicting") },
    { checksInfo: async () => ci("failing") },
  ];
  for (const c of cases) {
    const h = harness(c, [LABEL]);
    await readyOnce(h.deps);
    assert.deepEqual(h.removed, [{ n: 4706, label: LABEL }]);
    assert.equal(h.added.length, 0);
  }
});

// A merge queue rebasing the branch briefly makes CI pending / mergeable unknown.
// Those transient states must not yank a queued PR's label out from under it.
test("readyOnce holds the label through a transient not-ready state", async () => {
  const cases: Partial<PrReadyDeps>[] = [
    { mergeableInfo: async () => merge("unknown") },
    { checksInfo: async () => ci("pending") },
  ];
  for (const c of cases) {
    const h = harness(c, [LABEL]);
    await readyOnce(h.deps);
    assert.equal(h.removed.length, 0);
    assert.equal(h.added.length, 0);
    assert.equal(h.calls.labels, 1); // a hold reads labels to reconcile the board but never writes
  }
});

test("readyOnce leaves an unlabeled not-ready PR alone", async () => {
  for (const c of [{ checksInfo: async () => ci("failing") }, { checksInfo: async () => ci("pending") }] as Partial<PrReadyDeps>[]) {
    const h = harness(c, []);
    await readyOnce(h.deps);
    assert.equal(h.added.length, 0);
    assert.equal(h.removed.length, 0);
  }
});

test("readyOnce treats no CI (none) as passing", async () => {
  const h = harness({ checksInfo: async () => ci("none") }, []);
  await readyOnce(h.deps);
  assert.deepEqual(h.added, [{ n: 4706, label: LABEL }]);
});

test("readyOnce skips draft PRs entirely", async () => {
  const h = harness({ listOpenPRs: async () => [pr(4706, { isDraft: true })] }, []);
  await readyOnce(h.deps);
  assert.equal(h.added.length, 0);
  assert.equal(h.removed.length, 0);
  assert.equal(h.calls.unresolved, 0);
  assert.equal(h.calls.labels, 0);
});

test("readyOnce skips a PR whose readiness read errors, leaving the label untouched", async () => {
  const h = harness(
    {
      mergeableInfo: async () => {
        throw new Error("boom");
      },
    },
    [LABEL],
  );
  await readyOnce(h.deps); // must not throw
  assert.equal(h.added.length, 0);
  assert.equal(h.removed.length, 0);
  assert.equal(h.calls.labels, 0);
});

test("readyOnce logs an addLabel failure and continues to the next PR", async () => {
  const added: number[] = [];
  const logs: string[] = [];
  const h = harness(
    {
      listOpenPRs: async () => [pr(1), pr(2)],
      addLabel: async (n) => {
        if (n === 1) throw new Error("no such label");
        added.push(n);
      },
      log: (m) => void logs.push(m),
    },
    [],
  );
  await readyOnce(h.deps);
  assert.deepEqual(added, [2]);
  assert.ok(logs.some((l) => l.includes("#1")));
});

test("readyOnce short-circuits: an unresolved comment skips the mergeable and CI reads", async () => {
  const h = harness({ unresolvedInfo: async () => info(2) }, [LABEL]);
  await readyOnce(h.deps);
  assert.equal(h.calls.mergeable, 0);
  assert.equal(h.calls.checks, 0);
  assert.deepEqual(h.removed, [{ n: 4706, label: LABEL }]);
});

test("readyOnce survives a pr list failure without throwing", async () => {
  const h = harness({
    listOpenPRs: async () => {
      throw new Error("gh down");
    },
  });
  await readyOnce(h.deps);
  assert.equal(h.added.length, 0);
  assert.equal(h.removed.length, 0);
});

test("readyOnce does not re-add the ready label to a blocked PR (green own CI)", async () => {
  const h = harness({}, ["blocked"]);
  await readyOnce(h.deps);
  assert.equal(h.added.length, 0);
  assert.equal(h.removed.length, 0);
});

test("readyOnce still labels a clean PR that is not blocked", async () => {
  const h = harness({}, []);
  await readyOnce(h.deps);
  assert.deepEqual(h.added, [{ n: 4706, label: LABEL }]);
});

test("readyOnce does not remove ready-to-merge from a blocked PR that regressed", async () => {
  // Failing CI => verdict "regressed"; the PR carries both the ready label and the
  // blocked label. Without the blocked guard, readyOnce would strip the ready label;
  // the guard must leave both labels untouched (Aviator owns this PR now).
  const h = harness({ checksInfo: async () => ci("failing") }, [LABEL, "blocked"]);
  await readyOnce(h.deps);
  assert.equal(h.removed.length, 0);
  assert.equal(h.added.length, 0);
});

test("readyOnce reports a ready verdict via onVerdict even when the label is already present", async () => {
  const verdicts: { n: number; v: string }[] = [];
  const h = harness({ onVerdict: (n, v) => void verdicts.push({ n, v }) }, [LABEL]);
  await readyOnce(h.deps);
  assert.equal(h.added.length, 0); // label already there: no write
  assert.deepEqual(verdicts, [{ n: 4706, v: "ready" }]);
});

test("readyOnce reports a regressed verdict via onVerdict", async () => {
  const verdicts: string[] = [];
  const h = harness(
    { checksInfo: async () => ci("failing"), onVerdict: (_n, v) => void verdicts.push(v) },
    [LABEL],
  );
  await readyOnce(h.deps);
  assert.deepEqual(verdicts, ["regressed"]);
});

test("readyOnce reports the hold verdict for a labeled held PR so the board reconciles", async () => {
  const seen: { v: string; hasLabel: boolean }[] = [];
  const h = harness(
    { checksInfo: async () => ci("pending"), onVerdict: (_n, v, hasLabel) => void seen.push({ v, hasLabel }) },
    [LABEL],
  );
  await readyOnce(h.deps);
  assert.deepEqual(seen, [{ v: "hold", hasLabel: true }]);
});

test("readyOnce reports the hold verdict with hasLabel false for an unlabeled held PR", async () => {
  const seen: { v: string; hasLabel: boolean }[] = [];
  const h = harness(
    { checksInfo: async () => ci("pending"), onVerdict: (_n, v, hasLabel) => void seen.push({ v, hasLabel }) },
    [],
  );
  await readyOnce(h.deps);
  assert.deepEqual(seen, [{ v: "hold", hasLabel: false }]);
});

test("readyOnce does not report a verdict for a blocked PR", async () => {
  const verdicts: string[] = [];
  const h = harness({ onVerdict: (_n, v) => void verdicts.push(v) }, ["blocked"]);
  await readyOnce(h.deps);
  assert.deepEqual(verdicts, []);
});

test("boardReadyToMerge: ready always, hold only when already labeled, never regressed", () => {
  assert.equal(boardReadyToMerge("ready", false), true);
  assert.equal(boardReadyToMerge("ready", true), true);
  assert.equal(boardReadyToMerge("hold", true), true); // queued: ready and labeled, CI re-running
  assert.equal(boardReadyToMerge("hold", false), false); // genuinely pending, not yet ready
  assert.equal(boardReadyToMerge("regressed", true), false);
  assert.equal(boardReadyToMerge("regressed", false), false);
});
