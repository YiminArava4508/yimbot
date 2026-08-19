import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChecksInfo, CiState, MergeableInfo, MergeableState, OpenPR, UnresolvedInfo } from "./gh.ts";
import { boardReadyToMerge, freshReadyState, type PrReadyDeps, readyOnce } from "./pr-ready.ts";

const LABEL = "ready-to-merge";

function pr(number: number, overrides: Partial<OpenPR> = {}): OpenPR {
  return { number, headRefName: `eng-${number}-x`, isDraft: false, ...overrides };
}
function info(count: number): UnresolvedInfo {
  const at = count > 0 ? 1000 : null;
  return { count, newestOtherCommentAt: at, newestTrustedCommentAt: null, newestHumanCommentAt: at };
}
function ci(state: CiState): ChecksInfo {
  return { state, headSha: "sha" };
}
function merge(state: MergeableState): MergeableInfo {
  return { state, headSha: "sha" };
}

type Harness = {
  state: ReturnType<typeof freshReadyState>;
  deps: PrReadyDeps;
  added: { n: number; label: string }[];
  removed: { n: number; label: string }[];
  logs: string[];
  calls: { unresolved: number; mergeable: number; checks: number; labels: number };
};

// A fully-faked readyOnce environment. Defaults describe a single ready PR
// (#4706, no unresolved threads, mergeable, passing CI) in autonomous mode;
// `currentLabels` is what prLabels reports, and each override swaps in one
// not-ready signal. The removeLabel spy is an extra property beyond PrReadyDeps
// (hence the cast): readyOnce must never call one even if it is supplied.
function harness(overrides: Partial<PrReadyDeps> = {}, currentLabels: string[] = []): Harness {
  const added: { n: number; label: string }[] = [];
  const removed: { n: number; label: string }[] = [];
  const logs: string[] = [];
  const calls = { unresolved: 0, mergeable: 0, checks: 0, labels: 0 };
  const deps = {
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
    addLabel: async (n: number, label: string) => void added.push({ n, label }),
    removeLabel: async (n: number, label: string) => void removed.push({ n, label }),
    label: LABEL,
    blockedLabel: "blocked",
    soakMs: 0,
    now: () => 0,
    mode: () => "autonomous" as const,
    log: (m: string) => void logs.push(m),
    ...overrides,
  } as PrReadyDeps;
  return { state: freshReadyState(), deps, added, removed, logs, calls };
}

test("readyOnce adds the label to a ready PR that lacks it", async () => {
  const h = harness({}, []);
  await readyOnce(h.state, h.deps);
  assert.deepEqual(h.added, [{ n: 4706, label: LABEL }]);
  assert.equal(h.removed.length, 0);
});

test("readyOnce does not re-add the label to an already-labeled ready PR", async () => {
  const h = harness({}, [LABEL]);
  await readyOnce(h.state, h.deps);
  assert.equal(h.added.length, 0);
  assert.equal(h.removed.length, 0);
});

test("readyOnce keeps the label on a hard regression (never removes)", async () => {
  const cases: Partial<PrReadyDeps>[] = [
    { unresolvedInfo: async () => info(1) },
    { checksInfo: async () => ci("failing") },
  ];
  for (const c of cases) {
    const h = harness(c, [LABEL]);
    await readyOnce(h.state, h.deps);
    assert.equal(h.removed.length, 0);
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
    await readyOnce(h.state, h.deps);
    assert.equal(h.removed.length, 0);
    assert.equal(h.added.length, 0);
    assert.equal(h.calls.labels, 1); // a hold reads labels to reconcile the board but never writes
  }
});

// The repo's resolve-generated-conflicts sweep discovers PRs BY the ready-to-merge
// (or blocked) label, so stripping the label on a conflict hides the PR from the
// auto-heal that would fix generated-only conflicts for free. A conflict is
// therefore a hold, not a regression: leave the label alone either way.
test("readyOnce holds the label on a conflicting PR so the conflict sweep can heal it", async () => {
  const labeled = harness({ mergeableInfo: async () => merge("conflicting") }, [LABEL]);
  await readyOnce(labeled.state, labeled.deps);
  assert.equal(labeled.removed.length, 0);
  assert.equal(labeled.added.length, 0);

  const unlabeled = harness({ mergeableInfo: async () => merge("conflicting") }, []);
  await readyOnce(unlabeled.state, unlabeled.deps);
  assert.equal(unlabeled.added.length, 0);
  assert.equal(unlabeled.removed.length, 0);
});

test("readyOnce leaves an unlabeled not-ready PR alone", async () => {
  for (const c of [{ checksInfo: async () => ci("failing") }, { checksInfo: async () => ci("pending") }] as Partial<PrReadyDeps>[]) {
    const h = harness(c, []);
    await readyOnce(h.state, h.deps);
    assert.equal(h.added.length, 0);
    assert.equal(h.removed.length, 0);
  }
});

test("readyOnce treats no CI (none) as passing", async () => {
  const h = harness({ checksInfo: async () => ci("none") }, []);
  await readyOnce(h.state, h.deps);
  assert.deepEqual(h.added, [{ n: 4706, label: LABEL }]);
});

test("readyOnce never labels a draft PR, even a ready one", async () => {
  const h = harness({ listOpenPRs: async () => [pr(4706, { isDraft: true })] }, []);
  await readyOnce(h.state, h.deps);
  assert.equal(h.added.length, 0);
  assert.equal(h.removed.length, 0);
});

test("readyOnce leaves a labeled draft PR's label alone", async () => {
  const h = harness({ listOpenPRs: async () => [pr(4706, { isDraft: true })] }, [LABEL]);
  await readyOnce(h.state, h.deps);
  assert.equal(h.added.length, 0);
  assert.equal(h.removed.length, 0);
});

test("readyOnce still reports a draft's verdict so the board shows draft pr", async () => {
  const seen: { n: number; v: string; hasLabel: boolean; isDraft: boolean }[] = [];
  const h = harness(
    {
      listOpenPRs: async () => [pr(4706, { isDraft: true })],
      onVerdict: (n, v, hasLabel, isDraft) => void seen.push({ n, v, hasLabel, isDraft }),
    },
    [LABEL],
  );
  await readyOnce(h.state, h.deps);
  assert.deepEqual(seen, [{ n: 4706, v: "ready", hasLabel: true, isDraft: true }]);
});

test("readyOnce reports isDraft via onVerdict", async () => {
  const seen: { n: number; v: string; isDraft: boolean }[] = [];
  const h = harness(
    {
      listOpenPRs: async () => [pr(1, { isDraft: true }), pr(2)],
      onVerdict: (n, v, _hasLabel, isDraft) => void seen.push({ n, v, isDraft }),
    },
    [],
  );
  await readyOnce(h.state, h.deps);
  assert.deepEqual(seen, [
    { n: 1, v: "ready", isDraft: true },
    { n: 2, v: "ready", isDraft: false },
  ]);
});

test("readyOnce in supervised mode never adds the label, even to a ready PR", async () => {
  const h = harness({ mode: () => "supervised" }, []);
  await readyOnce(h.state, h.deps);
  assert.equal(h.added.length, 0);
  assert.equal(h.removed.length, 0);
});

test("readyOnce in supervised mode never removes a label a human put on", async () => {
  const h = harness({ mode: () => "supervised", checksInfo: async () => ci("failing") }, [LABEL]);
  await readyOnce(h.state, h.deps);
  assert.equal(h.removed.length, 0);
  assert.equal(h.added.length, 0);
});

test("readyOnce in supervised mode still reports verdicts so the board stays live", async () => {
  const seen: { n: number; v: string; hasLabel: boolean }[] = [];
  const h = harness(
    { mode: () => "supervised", onVerdict: (n, v, hasLabel) => void seen.push({ n, v, hasLabel }) },
    [LABEL],
  );
  await readyOnce(h.state, h.deps);
  assert.deepEqual(seen, [{ n: 4706, v: "ready", hasLabel: true }]);
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
  await readyOnce(h.state, h.deps); // must not throw
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
  await readyOnce(h.state, h.deps);
  assert.deepEqual(added, [2]);
  assert.ok(logs.some((l) => l.includes("#1")));
});

test("readyOnce short-circuits: an unresolved comment skips the mergeable and CI reads", async () => {
  const h = harness({ unresolvedInfo: async () => info(2) }, [LABEL]);
  await readyOnce(h.state, h.deps);
  assert.equal(h.calls.mergeable, 0);
  assert.equal(h.calls.checks, 0);
  assert.equal(h.removed.length, 0);
});

test("readyOnce survives a pr list failure without throwing", async () => {
  const h = harness({
    listOpenPRs: async () => {
      throw new Error("gh down");
    },
  });
  await readyOnce(h.state, h.deps);
  assert.equal(h.added.length, 0);
  assert.equal(h.removed.length, 0);
});

test("readyOnce does not re-add the ready label to a blocked PR (green own CI)", async () => {
  const h = harness({}, ["blocked"]);
  await readyOnce(h.state, h.deps);
  assert.equal(h.added.length, 0);
  assert.equal(h.removed.length, 0);
});

test("readyOnce still labels a clean PR that is not blocked", async () => {
  const h = harness({}, []);
  await readyOnce(h.state, h.deps);
  assert.deepEqual(h.added, [{ n: 4706, label: LABEL }]);
});

test("readyOnce leaves a blocked PR's labels untouched even when it regressed", async () => {
  // Failing CI => verdict "regressed"; the PR carries both the ready label and the
  // blocked label. The blocked guard leaves both labels untouched (Aviator owns
  // this PR now), and no verdict is reported either.
  const h = harness({ checksInfo: async () => ci("failing") }, [LABEL, "blocked"]);
  await readyOnce(h.state, h.deps);
  assert.equal(h.removed.length, 0);
  assert.equal(h.added.length, 0);
});

test("readyOnce reports a ready verdict via onVerdict even when the label is already present", async () => {
  const verdicts: { n: number; v: string }[] = [];
  const h = harness({ onVerdict: (n, v) => void verdicts.push({ n, v }) }, [LABEL]);
  await readyOnce(h.state, h.deps);
  assert.equal(h.added.length, 0); // label already there: no write
  assert.deepEqual(verdicts, [{ n: 4706, v: "ready" }]);
});

test("readyOnce reports a regressed verdict via onVerdict", async () => {
  const verdicts: string[] = [];
  const h = harness(
    { checksInfo: async () => ci("failing"), onVerdict: (_n, v) => void verdicts.push(v) },
    [LABEL],
  );
  await readyOnce(h.state, h.deps);
  assert.deepEqual(verdicts, ["regressed"]);
});

test("readyOnce reports the hold verdict for a labeled held PR so the board reconciles", async () => {
  const seen: { v: string; hasLabel: boolean }[] = [];
  const h = harness(
    { checksInfo: async () => ci("pending"), onVerdict: (_n, v, hasLabel) => void seen.push({ v, hasLabel }) },
    [LABEL],
  );
  await readyOnce(h.state, h.deps);
  assert.deepEqual(seen, [{ v: "hold", hasLabel: true }]);
});

test("readyOnce reports the hold verdict with hasLabel false for an unlabeled held PR", async () => {
  const seen: { v: string; hasLabel: boolean }[] = [];
  const h = harness(
    { checksInfo: async () => ci("pending"), onVerdict: (_n, v, hasLabel) => void seen.push({ v, hasLabel }) },
    [],
  );
  await readyOnce(h.state, h.deps);
  assert.deepEqual(seen, [{ v: "hold", hasLabel: false }]);
});

test("readyOnce does not report a verdict for a blocked PR", async () => {
  const verdicts: string[] = [];
  const h = harness({ onVerdict: (_n, v) => void verdicts.push(v) }, ["blocked"]);
  await readyOnce(h.state, h.deps);
  assert.deepEqual(verdicts, []);
});

// The latch: once the label has been on a PR (added by the bot or observed),
// the ready step never adds it again for that PR. A removal by a human or the
// merge queue is final, not fought every heartbeat.
test("readyOnce does not re-add the label after adding it once and seeing it removed", async () => {
  let labels: string[] = [];
  const h = harness({ prLabels: async () => labels }, []);
  await readyOnce(h.state, h.deps);
  assert.deepEqual(h.added, [{ n: 4706, label: LABEL }]);
  labels = []; // label removed externally; PR still classifies as ready
  await readyOnce(h.state, h.deps);
  await readyOnce(h.state, h.deps);
  assert.equal(h.added.length, 1); // still just the first add
});

test("readyOnce does not add the label to a PR that once carried it, even if the bot never added it", async () => {
  let labels = [LABEL]; // human-applied
  const h = harness({ prLabels: async () => labels }, []);
  await readyOnce(h.state, h.deps);
  assert.equal(h.added.length, 0);
  labels = []; // human took it back off
  await readyOnce(h.state, h.deps);
  assert.equal(h.added.length, 0);
});

test("readyOnce observed in supervised mode still latches, so switching to autonomous does not re-add", async () => {
  let mode: "supervised" | "autonomous" = "supervised";
  let labels = [LABEL];
  const h = harness({ mode: () => mode, prLabels: async () => labels }, []);
  await readyOnce(h.state, h.deps);
  mode = "autonomous";
  labels = []; // removed while supervised
  await readyOnce(h.state, h.deps);
  assert.equal(h.added.length, 0);
});

test("readyOnce does not latch on an addLabel failure, so the add retries next tick", async () => {
  let fail = true;
  const added: number[] = [];
  const h = harness(
    {
      addLabel: async (n) => {
        if (fail) throw new Error("boom");
        added.push(n);
      },
    },
    [],
  );
  await readyOnce(h.state, h.deps);
  assert.deepEqual(added, []);
  fail = false;
  await readyOnce(h.state, h.deps);
  assert.deepEqual(added, [4706]);
});

test("readyOnce latches per PR: one latched PR does not block labeling another", async () => {
  const labelsByPr = new Map<number, string[]>([
    [1, [LABEL]],
    [2, []],
  ]);
  const h = harness(
    {
      listOpenPRs: async () => [pr(1), pr(2)],
      prLabels: async (n) => labelsByPr.get(n) ?? [],
    },
    [],
  );
  await readyOnce(h.state, h.deps);
  assert.equal(h.added.length, 0); // PR 1 occupies the queue slot
  labelsByPr.set(1, []); // PR 1's label removed: latched, stays off; slot frees
  await readyOnce(h.state, h.deps);
  assert.deepEqual(h.added, [{ n: 2, label: LABEL }]); // latch is per PR: 2 still labels
  await readyOnce(h.state, h.deps);
  assert.equal(h.added.length, 1);
});

// The soak: a ready verdict must hold for soakMs before the label goes on, so a
// PR that just went green (and may be about to change again) is not queued on
// the first tick it looks clean.
test("readyOnce soaks: no add until the ready verdict has held for soakMs", async () => {
  let t = 0;
  const h = harness({ soakMs: 10 * 60_000, now: () => t }, []);
  await readyOnce(h.state, h.deps); // ready first observed at t=0
  assert.equal(h.added.length, 0);
  t = 5 * 60_000;
  await readyOnce(h.state, h.deps);
  assert.equal(h.added.length, 0);
  t = 10 * 60_000;
  await readyOnce(h.state, h.deps);
  assert.deepEqual(h.added, [{ n: 4706, label: LABEL }]);
});

test("readyOnce resets the soak clock when readiness lapses", async () => {
  let t = 0;
  let ciState: CiState = "passing";
  const h = harness({ soakMs: 10 * 60_000, now: () => t, checksInfo: async () => ci(ciState) }, []);
  await readyOnce(h.state, h.deps); // ready at t=0
  t = 5 * 60_000;
  ciState = "failing"; // regression mid-soak
  await readyOnce(h.state, h.deps);
  t = 6 * 60_000;
  ciState = "passing"; // ready again: the clock restarts here
  await readyOnce(h.state, h.deps);
  t = 12 * 60_000; // 12m after first ready, but only 6m after the restart
  await readyOnce(h.state, h.deps);
  assert.equal(h.added.length, 0);
  t = 16 * 60_000; // 10m after the restart
  await readyOnce(h.state, h.deps);
  assert.deepEqual(h.added, [{ n: 4706, label: LABEL }]);
});

// Serialization: at most one bot-queued PR at a time. While any open PR carries
// the ready label (queued) or the blocked label (Aviator's, will be re-queued),
// the step adds nothing, so two bot-queued PRs can never fight in the queue.
test("readyOnce adds nothing while another open PR carries the ready label", async () => {
  const labelsByPr = new Map<number, string[]>([
    [1, []],
    [2, [LABEL]],
  ]);
  const h = harness(
    {
      listOpenPRs: async () => [pr(1), pr(2)],
      prLabels: async (n) => labelsByPr.get(n) ?? [],
    },
    [],
  );
  await readyOnce(h.state, h.deps); // PR 2 occupies the slot even though it comes after PR 1
  assert.equal(h.added.length, 0);
  labelsByPr.delete(2);
  const merged = harness(
    { listOpenPRs: async () => [pr(1)], prLabels: async (n) => labelsByPr.get(n) ?? [] },
    [],
  );
  merged.state = h.state;
  await readyOnce(merged.state, merged.deps); // PR 2 merged (gone from the list): slot free
  assert.deepEqual(merged.added, [{ n: 1, label: LABEL }]);
});

test("readyOnce adds nothing while another open PR is blocked", async () => {
  const labelsByPr = new Map<number, string[]>([
    [1, []],
    [2, ["blocked"]],
  ]);
  const h = harness(
    {
      listOpenPRs: async () => [pr(1), pr(2)],
      prLabels: async (n) => labelsByPr.get(n) ?? [],
    },
    [],
  );
  await readyOnce(h.state, h.deps);
  assert.equal(h.added.length, 0);
});

test("readyOnce labels at most one PR per tick, then waits for it to leave the queue", async () => {
  const labelsByPr = new Map<number, string[]>([
    [1, []],
    [2, []],
  ]);
  const h = harness(
    {
      listOpenPRs: async () => [pr(1), pr(2)],
      prLabels: async (n) => labelsByPr.get(n) ?? [],
      addLabel: async (n, label) => {
        h.added.push({ n, label });
        labelsByPr.set(n, [label]);
      },
    },
    [],
  );
  await readyOnce(h.state, h.deps);
  assert.deepEqual(h.added, [{ n: 1, label: LABEL }]); // both ready: only the first labels
  await readyOnce(h.state, h.deps);
  assert.equal(h.added.length, 1); // PR 1 still queued: PR 2 keeps waiting
  labelsByPr.delete(1);
  const next = harness(
    {
      listOpenPRs: async () => [pr(2)],
      prLabels: async (n) => labelsByPr.get(n) ?? [],
    },
    [],
  );
  next.state = h.state;
  await readyOnce(next.state, next.deps); // PR 1 merged: PR 2's turn
  assert.deepEqual(next.added, [{ n: 2, label: LABEL }]);
});

test("boardReadyToMerge: ready always, hold only when already labeled, never regressed", () => {
  assert.equal(boardReadyToMerge("ready", false), true);
  assert.equal(boardReadyToMerge("ready", true), true);
  assert.equal(boardReadyToMerge("hold", true), true); // queued: ready and labeled, CI re-running
  assert.equal(boardReadyToMerge("hold", false), false); // genuinely pending, not yet ready
  assert.equal(boardReadyToMerge("regressed", true), false);
  assert.equal(boardReadyToMerge("regressed", false), false);
});
