import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChecksInfo, CiState, MergeableInfo, MergeableState, OpenPR, UnresolvedInfo } from "./gh.ts";
import { createQueueGate } from "./queue-overlap.ts";
import { boardReadyToMerge, boardSection, boardReadyKind, freshReadyState, type PrReadyDeps, readyOnce } from "./pr-ready.ts";

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
// `currentLabels` is what prState reports, and each override swaps in one
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
    // Mirrors the real read: labels and the draft flag come back together, the
    // draft flag matching whatever the PR list says unless a test overrides it
    // to make the two disagree.
    prState: async (n: number) => {
      calls.labels++;
      const listed = await (overrides.listOpenPRs ?? (async () => [pr(4706)]))();
      return { labels: currentLabels, isDraft: listed.find((p) => p.number === n)?.isDraft ?? false, approved: false };
    },
    addLabel: async (n: number, label: string) => void added.push({ n, label }),
    removeLabel: async (n: number, label: string) => void removed.push({ n, label }),
    label: LABEL,
    blockedLabel: "blocked",
    maxQueued: 3,
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
  assert.equal(h.calls.labels, 1); // labels are read first, for the board's section
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

test("readyOnce reports why a PR regressed via onVerdict", async () => {
  const reasons: (string | undefined)[] = [];
  const onVerdict: PrReadyDeps["onVerdict"] = (_n, _v, _hasLabel, _isDraft, reason) => void reasons.push(reason);
  const ci_ = harness({ checksInfo: async () => ci("failing"), onVerdict }, [LABEL]);
  await readyOnce(ci_.state, ci_.deps);
  const threads = harness({ unresolvedInfo: async () => info(1), onVerdict }, [LABEL]);
  await readyOnce(threads.state, threads.deps);
  const ready = harness({ onVerdict }, [LABEL]);
  await readyOnce(ready.state, ready.deps);
  assert.deepEqual(reasons, ["ci", "threads", undefined]);
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

test("readyOnce reports a blocked PR via onBlocked, so the board leaves ready-to-merge", async () => {
  const blocked: number[] = [];
  const h = harness({ onBlocked: (n) => void blocked.push(n) }, ["blocked"]);
  await readyOnce(h.state, h.deps);
  assert.deepEqual(blocked, [4706]);
});

test("readyOnce does not call onBlocked for an unblocked PR", async () => {
  const blocked: number[] = [];
  const h = harness({ onBlocked: (n) => void blocked.push(n) }, [LABEL]);
  await readyOnce(h.state, h.deps);
  assert.deepEqual(blocked, []);
});

// The latch: once the label has been on a PR (added by the bot or observed),
// the ready step never adds it again for that PR. A removal by a human or the
// merge queue is final, not fought every heartbeat.
test("readyOnce does not re-add the label after adding it once and seeing it removed", async () => {
  let labels: string[] = [];
  const h = harness({ prState: async () => ({ labels, isDraft: false, approved: false }) }, []);
  await readyOnce(h.state, h.deps);
  assert.deepEqual(h.added, [{ n: 4706, label: LABEL }]);
  labels = []; // label removed externally; PR still classifies as ready
  await readyOnce(h.state, h.deps);
  await readyOnce(h.state, h.deps);
  assert.equal(h.added.length, 1); // still just the first add
});

test("readyOnce does not add the label to a PR that once carried it, even if the bot never added it", async () => {
  let labels = [LABEL]; // human-applied
  const h = harness({ prState: async () => ({ labels, isDraft: false, approved: false }) }, []);
  await readyOnce(h.state, h.deps);
  assert.equal(h.added.length, 0);
  labels = []; // human took it back off
  await readyOnce(h.state, h.deps);
  assert.equal(h.added.length, 0);
});

test("readyOnce observed in supervised mode still latches, so switching to autonomous does not re-add", async () => {
  let mode: "supervised" | "autonomous" = "supervised";
  let labels = [LABEL];
  const h = harness({ mode: () => mode, prState: async () => ({ labels, isDraft: false, approved: false }) }, []);
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

test("readyOnce latches per PR: a latched PR whose label was removed is never relabeled", async () => {
  const h = fleet({ 1: { labels: [LABEL] }, 2: {} });
  await readyOnce(h.state, h.deps);
  assert.deepEqual(h.added, [{ n: 2, label: LABEL }]); // labeled PR 1 blocks nothing
  const next = fleet({ 1: {}, 2: {} });
  next.state = h.state;
  await readyOnce(next.state, next.deps); // PR 1's label removed: latched, stays off
  assert.equal(next.added.length, 0);
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

// Queue slots: only a labeled AND approved PR (or a blocked one, due a re-queue)
// is something Aviator batches, so only those take one of maxQueued slots.
// Labeling an unapproved PR takes no slot: the label is what pings reviewers.
type PrSpec = { labels?: string[]; approved?: boolean };
function fleet(specs: Record<number, PrSpec>, overrides: Partial<PrReadyDeps> = {}): Harness {
  const live = new Map(Object.entries(specs).map(([n, s]) => [Number(n), { labels: s.labels ?? [], approved: s.approved ?? false }]));
  const h: Harness = harness(
    {
      listOpenPRs: async () => [...live.keys()].map((n) => pr(n)),
      prState: async (n: number) => ({ ...live.get(n)!, isDraft: false }),
      addLabel: async (n, label) => {
        h.added.push({ n, label });
        live.get(n)!.labels = [label];
      },
      ...overrides,
    },
    [],
  );
  return h;
}

test("readyOnce: an unapproved labeled PR does not block labeling others", async () => {
  const h = fleet({ 1: {}, 2: { labels: [LABEL] } }, { maxQueued: 1 });
  await readyOnce(h.state, h.deps);
  assert.deepEqual(h.added, [{ n: 1, label: LABEL }]);
});

test("readyOnce: approved labeled PRs fill the slots, so an approved candidate waits", async () => {
  const h = fleet(
    {
      1: { labels: [LABEL], approved: true },
      2: { labels: [LABEL], approved: true },
      3: { labels: [LABEL], approved: true },
      4: { approved: true },
    },
    { maxQueued: 3 },
  );
  await readyOnce(h.state, h.deps);
  assert.equal(h.added.length, 0);
});

test("readyOnce: unapproved candidates still get labeled when every slot is taken", async () => {
  const h = fleet(
    { 1: { labels: [LABEL], approved: true }, 2: { labels: [LABEL], approved: true }, 3: { labels: [LABEL], approved: true }, 4: {}, 5: {} },
    { maxQueued: 3 },
  );
  await readyOnce(h.state, h.deps);
  assert.deepEqual(h.added.map((a) => a.n), [4, 5]);
});

test("readyOnce: an approved candidate takes a free slot", async () => {
  const h = fleet({ 1: { labels: [LABEL], approved: true }, 2: { approved: true } }, { maxQueued: 3 });
  await readyOnce(h.state, h.deps);
  assert.deepEqual(h.added, [{ n: 2, label: LABEL }]);
});

test("readyOnce: approved candidates beyond the free slots wait, oldest-ready first", async () => {
  const since = new Map([[1, 300], [2, 100], [3, 200]]);
  const h = fleet({ 1: { approved: true }, 2: { approved: true }, 3: { approved: true } }, { maxQueued: 2, now: () => 1000 });
  for (const [n, t] of since) h.state.readySince.set(n, t);
  await readyOnce(h.state, h.deps);
  assert.deepEqual(h.added.map((a) => a.n), [2, 3]);
});

test("readyOnce: a blocked PR takes a slot whether or not it is approved", async () => {
  const h = fleet({ 1: { labels: ["blocked"] }, 2: { approved: true } }, { maxQueued: 1 });
  await readyOnce(h.state, h.deps);
  assert.equal(h.added.length, 0);
});

test("readyOnce: a blocked PR leaves the other slots free", async () => {
  const h = fleet({ 1: { labels: ["blocked"] }, 2: { approved: true } }, { maxQueued: 2 });
  await readyOnce(h.state, h.deps);
  assert.deepEqual(h.added, [{ n: 2, label: LABEL }]);
});

test("readyOnce labels every eligible candidate in one tick", async () => {
  const h = fleet({ 1: {}, 2: {}, 3: {}, 4: {}, 5: {} }, { maxQueued: 1 });
  await readyOnce(h.state, h.deps);
  assert.deepEqual(h.added.map((a) => a.n), [1, 2, 3, 4, 5]);
});

test("readyOnce: an addLabel failure on one candidate does not stop the rest", async () => {
  const h = fleet({ 1: {}, 2: {}, 3: {} });
  const base = h.deps.addLabel;
  h.deps.addLabel = async (n, label) => {
    if (n === 2) throw new Error("boom");
    return base(n, label);
  };
  await readyOnce(h.state, h.deps);
  assert.deepEqual(h.added.map((a) => a.n), [1, 3]);
  assert.ok(h.logs.some((l) => l.includes("add label failed for PR #2")));
  assert.equal(h.state.latched.has(2), false);
});

test("readyOnce: a failed add on an approved candidate does not use up its slot", async () => {
  const h = fleet({ 1: { approved: true }, 2: { approved: true } }, { maxQueued: 1, now: () => 1000 });
  const base = h.deps.addLabel;
  h.deps.addLabel = async (n, label) => {
    if (n === 1) throw new Error("boom");
    return base(n, label);
  };
  h.state.readySince.set(1, 0);
  h.state.readySince.set(2, 1);
  await readyOnce(h.state, h.deps);
  assert.deepEqual(h.added.map((a) => a.n), [2]);
});

test("readyOnce: maxAwaitingReview caps unapproved labels, oldest-ready first", async () => {
  const h = fleet({ 1: {}, 2: {}, 3: {}, 4: {} }, { maxAwaitingReview: 2, now: () => 1000 });
  h.state.readySince.set(1, 400);
  h.state.readySince.set(2, 100);
  h.state.readySince.set(3, 300);
  h.state.readySince.set(4, 200);
  await readyOnce(h.state, h.deps);
  assert.deepEqual(h.added.map((a) => a.n), [2, 4]);
});

test("readyOnce: maxAwaitingReview counts already-labeled unapproved PRs", async () => {
  const h = fleet({ 1: { labels: [LABEL] }, 2: {}, 3: {} }, { maxAwaitingReview: 2 });
  await readyOnce(h.state, h.deps);
  assert.deepEqual(h.added.map((a) => a.n), [2]);
});

test("readyOnce: approved labeled PRs do not count toward maxAwaitingReview", async () => {
  const h = fleet({ 1: { labels: [LABEL], approved: true }, 2: {} }, { maxAwaitingReview: 1 });
  await readyOnce(h.state, h.deps);
  assert.deepEqual(h.added.map((a) => a.n), [2]);
});

test("readyOnce: maxAwaitingReview does not hold back approved candidates", async () => {
  const h = fleet({ 1: { labels: [LABEL] }, 2: { approved: true } }, { maxAwaitingReview: 1, maxQueued: 3 });
  await readyOnce(h.state, h.deps);
  assert.deepEqual(h.added.map((a) => a.n), [2]);
});

test("readyOnce: a labeled manual-merge PR counts toward no cap", async () => {
  const h = fleet(
    { 1: { labels: [LABEL] }, 2: {} },
    { maxAwaitingReview: 1, mergesManually: async (n) => n === 1 },
  );
  await readyOnce(h.state, h.deps);
  assert.deepEqual(h.added.map((a) => a.n), [2]);
});

test("boardReadyToMerge: ready always, hold only when already labeled, never regressed", () => {
  assert.equal(boardReadyToMerge("ready", false), true);
  assert.equal(boardReadyToMerge("ready", true), true);
  assert.equal(boardReadyToMerge("hold", true), true); // queued: ready and labeled, CI re-running
  assert.equal(boardReadyToMerge("hold", false), false); // genuinely pending, not yet ready
  assert.equal(boardReadyToMerge("regressed", true), false);
  assert.equal(boardReadyToMerge("regressed", false), false);
});

test("boardSection: a draft always belongs to the review pane, label or not", () => {
  assert.equal(boardSection(true, false, false), "review");
  assert.equal(boardSection(true, true, false), "review");
});

test("boardSection: a labeled non-draft belongs to the merge pane", () => {
  assert.equal(boardSection(false, true, false), "merge");
});

test("boardSection: an unlabeled open PR waits in the review pane with the drafts, in either mode", () => {
  assert.equal(boardSection(false, false, false), "review");
});

test("boardSection: a blocked PR stays in the tasks pane for the fix", () => {
  assert.equal(boardSection(false, false, true), "tasks");
});

test("boardReadyKind: a draft says draft pr whatever the label or mode", () => {
  assert.equal(boardReadyKind(true, false, "supervised"), "draft_pr");
  assert.equal(boardReadyKind(true, true, "autonomous"), "draft_pr");
});

test("boardReadyKind: a labeled PR is ready to merge in both modes", () => {
  assert.equal(boardReadyKind(false, true, "supervised"), "ready_to_merge");
  assert.equal(boardReadyKind(false, true, "autonomous"), "ready_to_merge");
});

test("boardReadyKind: an unlabeled ready PR prompts the human only in supervised mode", () => {
  assert.equal(boardReadyKind(false, false, "supervised"), "ready_unqueued");
  assert.equal(boardReadyKind(false, false, "autonomous"), "ready_to_merge");
});

test("readyOnce reports each open PR's section", async () => {
  const seen: { n: number; section: string }[] = [];
  const h = harness(
    {
      listOpenPRs: async () => [pr(1), pr(2, { isDraft: true })],
      onSection: (n, section) => void seen.push({ n, section }),
    },
    [LABEL],
  );
  await readyOnce(h.state, h.deps);
  assert.deepEqual(seen, [
    { n: 1, section: "merge" },
    { n: 2, section: "review" },
  ]);
});

test("readyOnce moves a PR it labels this tick to the merge section right away", async () => {
  const seen: { n: number; section: string }[] = [];
  const h = harness({ onSection: (n, s) => void seen.push({ n, section: s }) }, []);
  await readyOnce(h.state, h.deps);
  assert.deepEqual(h.added, [{ n: 4706, label: LABEL }]);
  assert.deepEqual(seen, [
    { n: 4706, section: "review" },
    { n: 4706, section: "merge" },
  ]);
});

test("readyOnce leaves the section alone when the label add fails", async () => {
  const seen: { n: number; section: string }[] = [];
  const h = harness(
    {
      addLabel: async () => {
        throw new Error("boom");
      },
      onSection: (n, s) => void seen.push({ n, section: s }),
    },
    [],
  );
  await readyOnce(h.state, h.deps);
  assert.deepEqual(seen, [{ n: 4706, section: "review" }]);
});

test("readyOnce reports a section for a blocked PR even though it reports no verdict", async () => {
  // Aviator swaps ready-to-merge for blocked, so a blocked PR has genuinely
  // left the merge queue and the board must say so. Its labels stay the
  // blocked-fix flow's to write.
  const seen: { n: number; section: string }[] = [];
  const verdicts: string[] = [];
  const h = harness(
    { onSection: (n, section) => void seen.push({ n, section }), onVerdict: (_n, v) => void verdicts.push(v) },
    ["blocked"],
  );
  await readyOnce(h.state, h.deps);
  assert.deepEqual(seen, [{ n: 4706, section: "tasks" }]);
  assert.deepEqual(verdicts, []);
});

test("readyOnce reports a section in supervised mode too", async () => {
  const seen: { n: number; section: string }[] = [];
  const h = harness({ mode: () => "supervised", onSection: (n, s) => void seen.push({ n, section: s }) }, [LABEL]);
  await readyOnce(h.state, h.deps);
  assert.deepEqual(seen, [{ n: 4706, section: "merge" }]);
});

test("readyOnce reports a section for a PR whose readiness read failed", async () => {
  // The section comes from labels and the draft flag, neither of which the
  // classify reads touch, so a flaky CI read must not strand a row.
  const seen: { n: number; section: string }[] = [];
  const h = harness(
    {
      checksInfo: async () => {
        throw new Error("boom");
      },
      onSection: (n, s) => void seen.push({ n, section: s }),
    },
    [LABEL],
  );
  await readyOnce(h.state, h.deps);
  assert.deepEqual(seen, [{ n: 4706, section: "merge" }]);
});

test("readyOnce reports no section for a PR whose label read failed", async () => {
  const seen: { n: number; section: string }[] = [];
  const h = harness({
    prState: async () => {
      throw new Error("boom");
    },
    onSection: (n, s) => void seen.push({ n, section: s }),
  });
  await readyOnce(h.state, h.deps);
  assert.deepEqual(seen, []);
});

test("readyOnce places a PR by its live draft state, not the list snapshot's", async () => {
  // The snapshot is taken at tick start; an operator pressing r or y mid-tick
  // promotes and labels the PR. Reading the draft flag alongside the labels
  // keeps the same tick from bouncing the row back to the review pane.
  const seen: { n: number; section: string }[] = [];
  const h = harness(
    {
      listOpenPRs: async () => [pr(4706, { isDraft: true })],
      prState: async () => ({ labels: [LABEL], isDraft: false, approved: false }),
      onSection: (n, s) => void seen.push({ n, section: s }),
    },
  );
  await readyOnce(h.state, h.deps);
  assert.deepEqual(seen, [{ n: 4706, section: "merge" }]);
});

test("readyOnce reports the live draft state via onVerdict too", async () => {
  const seen: boolean[] = [];
  const h = harness({
    listOpenPRs: async () => [pr(4706, { isDraft: true })],
    prState: async () => ({ labels: [], isDraft: false, approved: false }),
    onVerdict: (_n, _v, _hasLabel, isDraft) => void seen.push(isDraft),
  });
  await readyOnce(h.state, h.deps);
  assert.deepEqual(seen, [false]);
});

test("readyOnce does not label a PR the live read still shows as a draft", async () => {
  const h = harness({
    listOpenPRs: async () => [pr(4706, { isDraft: false })],
    prState: async () => ({ labels: [], isDraft: true, approved: false }),
  });
  await readyOnce(h.state, h.deps);
  assert.deepEqual(h.added, []);
});

test("boardReadyKind: a repo without a merge queue says merge manually, label or not", () => {
  assert.equal(boardReadyKind(false, true, "supervised", true), "ready_manual");
  assert.equal(boardReadyKind(false, false, "supervised", true), "ready_manual");
  assert.equal(boardReadyKind(false, true, "autonomous", true), "ready_manual");
  assert.equal(boardReadyKind(true, true, "supervised", true), "draft_pr");
});

test("readyOnce tells onVerdict whether the PR's repo merges manually", async () => {
  const seen: { n: number; manual: boolean }[] = [];
  const h = harness(
    {
      listOpenPRs: async () => [pr(1), pr(2)],
      mergesManually: async (n) => n === 2,
      onVerdict: (n, _v, _hasLabel, _isDraft, _reason, manual) => void seen.push({ n, manual }),
    },
    [LABEL],
  );
  await readyOnce(h.state, h.deps);
  assert.deepEqual(seen, [
    { n: 1, manual: false },
    { n: 2, manual: true },
  ]);
});

test("readyOnce skips the verdict when the merge-queue read fails", async () => {
  const seen: boolean[] = [];
  const h = harness(
    {
      mergesManually: async () => {
        throw new Error("boom");
      },
      onVerdict: (_n, _v, _hasLabel, _isDraft, _reason, manual) => void seen.push(manual),
    },
    [LABEL],
  );
  await readyOnce(h.state, h.deps);
  assert.deepEqual(seen, []);
});

test("readyOnce never labels a PR in a repo without a merge queue", async () => {
  const h = harness({ mergesManually: async () => true, soakMs: 0 }, []);
  await readyOnce(h.state, h.deps);
  assert.equal(h.added.length, 0);
});

test("readyOnce does not let a labeled manual-merge PR hold the queue slot", async () => {
  const h = harness(
    {
      listOpenPRs: async () => [pr(1), pr(2)],
      prState: async (n: number) => ({ labels: n === 1 ? [LABEL] : [], isDraft: false, approved: false }),
      mergesManually: async (n) => n === 1,
      soakMs: 0,
    },
    [],
  );
  await readyOnce(h.state, h.deps);
  assert.deepEqual(h.added, [{ n: 2, label: LABEL }]);
});

test("a PR the overlap gate holds is not labeled and is reported with its holder", async () => {
  const heldReports: [number, number][] = [];
  const h = harness({
    listOpenPRs: async () => [pr(10), pr(20)],
    queueGate: async () => new Map([[10, null], [20, 10]]),
    onHeld: (n, holder) => void heldReports.push([n, holder]),
  });
  await readyOnce(h.state, h.deps);
  assert.deepEqual(h.added.map((a) => a.n), [10]);
  assert.deepEqual(heldReports, [[20, 10]]);
  assert.equal(h.state.latched.has(20), false);
});

test("a gate that throws fails open", async () => {
  const h = harness({
    queueGate: async () => {
      throw new Error("boom");
    },
  });
  await readyOnce(h.state, h.deps);
  assert.deepEqual(h.added.map((a) => a.n), [4706]);
});

test("three overlapping PRs are labeled one per merge", async () => {
  const files: Record<number, string[]> = { 8082: ["flags.ts"], 8087: ["flags.ts"], 8090: ["flags.ts"] };
  const open = new Set([8082, 8087, 8090]);
  const labeled = new Set<number>();
  const gate = createQueueGate({
    listQueued: async () => [...labeled].filter((n) => open.has(n)).map((n) => ({ n, headSha: "s", files: files[n] })),
    fetchFiles: async (n) => ({ headSha: "s", files: files[n] }),
    log: () => {},
  });
  const state = freshReadyState();
  const tick = async () => {
    const h = harness({
      listOpenPRs: async () => [...open].map((n) => pr(n)),
      prState: async (n: number) => ({ labels: labeled.has(n) ? [LABEL] : [], isDraft: false, approved: true }),
      addLabel: async (n: number) => void labeled.add(n),
      queueGate: gate,
    });
    await readyOnce(state, h.deps);
  };
  await tick();
  assert.deepEqual([...labeled], [8082]);
  await tick();
  assert.deepEqual([...labeled], [8082]);
  open.delete(8082);
  await tick();
  assert.deepEqual([...labeled], [8082, 8087]);
  open.delete(8087);
  await tick();
  assert.deepEqual([...labeled], [8082, 8087, 8090]);
});
