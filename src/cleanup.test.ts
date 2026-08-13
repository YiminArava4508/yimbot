import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildSplitGroups,
  type CleanupDeps,
  cleanupOnce,
  groupReady,
  isSplitSliceWindow,
  type OrphanFacts,
  type OrphanSweepDeps,
  readParentSession,
  sanitizeBranchToSession,
  selectMergedFixSessions,
  selectMergedWorktrees,
  selectOrphanWorktrees,
  type SplitGroup,
  sweepOrphanWorktrees,
  type Worktree,
} from "./cleanup.ts";
import type { MergedPR, OpenPR } from "./gh.ts";

const WT = "/home/ymbo/Work/worktrees";

function wt(branch: string, path = `${WT}/${branch}`): Worktree {
  return { path, branch };
}

test("selectMergedWorktrees keeps only worktrees whose branch merged", () => {
  const worktrees = [wt("eng-1-a"), wt("eng-2-b"), wt("eng-3-c")];
  const merged = new Set(["eng-1-a", "eng-3-c"]);
  assert.deepEqual(
    selectMergedWorktrees(worktrees, merged, WT).map((w) => w.branch),
    ["eng-1-a", "eng-3-c"],
  );
});

test("selectMergedWorktrees excludes worktrees outside the worktrees dir (e.g. the main checkout)", () => {
  const worktrees = [
    { path: "/home/ymbo/Work/gemini", branch: "main" },
    wt("eng-9-x"),
  ];
  const merged = new Set(["main", "eng-9-x"]);
  assert.deepEqual(
    selectMergedWorktrees(worktrees, merged, WT).map((w) => w.branch),
    ["eng-9-x"],
  );
});

test("selectMergedWorktrees tolerates a trailing slash on the worktrees dir", () => {
  const worktrees = [wt("eng-9-x")];
  const merged = new Set(["eng-9-x"]);
  assert.equal(selectMergedWorktrees(worktrees, merged, `${WT}/`).length, 1);
});

test("selectMergedFixSessions keeps only pr-<n>-fix sessions whose PR merged", () => {
  const sessions = ["pr-4730-fix", "pr-4731-fix", "eng-1-a", "work-session"];
  assert.deepEqual(selectMergedFixSessions(sessions, new Set([4730])), ["pr-4730-fix"]);
});

test("selectMergedFixSessions ignores non-fix session names", () => {
  const sessions = ["pr-4730-fixup", "xpr-4730-fix", "pr-fix", "pr--fix"];
  assert.deepEqual(selectMergedFixSessions(sessions, new Set([4730])), []);
});

test("selectMergedFixSessions also reaps merged pr-<n>-ci sessions", () => {
  const sessions = ["pr-4730-ci", "pr-4731-ci", "pr-4730-fix"];
  assert.deepEqual(selectMergedFixSessions(sessions, new Set([4730])), ["pr-4730-ci", "pr-4730-fix"]);
});

// A reattachable orphan: session-less, old enough. Overrides flip one guard.
function facts(over: Partial<OrphanFacts> & { branch: string }): OrphanFacts {
  return {
    worktree: wt(over.branch),
    hasSession: false,
    launching: false,
    ageMs: 10 * 60_000,
    ...over,
    ...(over.worktree ? { worktree: over.worktree } : {}),
  };
}

const SWEEP_OPTS = { grouped: new Set<string>(), resolved: new Set<string>(), minAgeMs: 5 * 60_000 };

test("selectOrphanWorktrees returns a session-less, old worktree", () => {
  const result = selectOrphanWorktrees([facts({ branch: "eng-1-a" })], SWEEP_OPTS);
  assert.deepEqual(result.map((w) => w.branch), ["eng-1-a"]);
});

test("selectOrphanWorktrees spares a worktree that has a live session", () => {
  const result = selectOrphanWorktrees([facts({ branch: "eng-1-a", hasSession: true })], SWEEP_OPTS);
  assert.deepEqual(result, []);
});

test("selectOrphanWorktrees reattaches a worktree with unsaved work (no inert gate)", () => {
  // A dirty / commits-ahead worktree is exactly the one we want re-coupled so its
  // in-progress work resumes; it is no longer spared.
  const result = selectOrphanWorktrees([facts({ branch: "eng-1-a" })], SWEEP_OPTS);
  assert.deepEqual(result.map((w) => w.branch), ["eng-1-a"]);
});

test("selectOrphanWorktrees spares a worktree younger than minAgeMs", () => {
  const result = selectOrphanWorktrees([facts({ branch: "eng-1-a", ageMs: 60_000 })], SWEEP_OPTS);
  assert.deepEqual(result, []);
});

test("selectOrphanWorktrees spares a worktree with a launch in progress", () => {
  const result = selectOrphanWorktrees([facts({ branch: "eng-1-a", launching: true })], SWEEP_OPTS);
  assert.deepEqual(result, []);
});

test("selectOrphanWorktrees spares a worktree in a split group", () => {
  const f = facts({ branch: "eng-1-a" });
  const opts = { ...SWEEP_OPTS, grouped: new Set([f.worktree.path]) };
  assert.deepEqual(selectOrphanWorktrees([f], opts), []);
});

test("selectOrphanWorktrees spares a resolved (merged/closed) worktree", () => {
  const opts = { ...SWEEP_OPTS, resolved: new Set(["eng-1-a"]) };
  assert.deepEqual(selectOrphanWorktrees([facts({ branch: "eng-1-a" })], opts), []);
});

test("selectOrphanWorktrees keeps only the orphans out of a mixed list", () => {
  const result = selectOrphanWorktrees(
    [
      facts({ branch: "eng-1-orphan" }),
      facts({ branch: "eng-2-active", hasSession: true }),
      facts({ branch: "eng-3-resolved" }),
      facts({ branch: "eng-4-orphan" }),
    ],
    { ...SWEEP_OPTS, resolved: new Set(["eng-3-resolved"]) },
  );
  assert.deepEqual(result.map((w) => w.branch), ["eng-1-orphan", "eng-4-orphan"]);
});

// Orchestrator deps: a session-less, old, unresolved set of worktrees by default.
// `sessioned`/`young`/`launching`/`resolved` name branches that flip one guard.
function sweepDeps(over: {
  worktrees: Worktree[];
  sessioned?: Set<string>;
  young?: Set<string>;
  launching?: Set<string>;
  resolved?: Set<string>;
  resolvedBranches?: () => Promise<Set<string>>;
  parents?: Record<string, string>;
  minAgeMs?: number;
  reattach?: (branch: string) => void;
}): { deps: OrphanSweepDeps; reattached: string[]; ageChecked: string[]; logs: string[] } {
  const reattached: string[] = [];
  const ageChecked: string[] = [];
  const logs: string[] = [];
  const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  const deps: OrphanSweepDeps = {
    listWorktrees: () => over.worktrees,
    listSessions: () => [],
    worktreesDir: WT,
    resolvedBranches: over.resolvedBranches ?? (async () => over.resolved ?? new Set<string>()),
    readParentSession: (p) => over.parents?.[p] ?? null,
    hasSessionFor: (name) => over.sessioned?.has(name) ?? false,
    isLaunching: (p) => over.launching?.has(base(p)) ?? false,
    ageMs: (p) => {
      ageChecked.push(base(p));
      return (over.young?.has(base(p)) ?? false) ? 60_000 : 10 * 60_000;
    },
    minAgeMs: over.minAgeMs ?? 5 * 60_000,
    reattach: over.reattach ?? ((b) => void reattached.push(b)),
    log: (m) => void logs.push(m),
  };
  return { deps, reattached, ageChecked, logs };
}

test("sweepOrphanWorktrees re-couples a true orphan", async () => {
  const { deps, reattached } = sweepDeps({ worktrees: [wt("eng-1-a")] });
  await sweepOrphanWorktrees(deps);
  assert.deepEqual(reattached, ["eng-1-a"]);
});

test("sweepOrphanWorktrees spares a worktree with a live session (and skips the age check)", async () => {
  const { deps, reattached, ageChecked } = sweepDeps({
    worktrees: [wt("eng-1-a")],
    sessioned: new Set(["eng-1-a"]),
  });
  await sweepOrphanWorktrees(deps);
  assert.deepEqual(reattached, []);
  assert.deepEqual(ageChecked, [], "no mtime stat on a session-backed worktree");
});

test("sweepOrphanWorktrees spares a worktree with a launch in progress (and skips the age check)", async () => {
  const { deps, reattached, ageChecked } = sweepDeps({
    worktrees: [wt("eng-1-a")],
    launching: new Set(["eng-1-a"]),
  });
  await sweepOrphanWorktrees(deps);
  assert.deepEqual(reattached, []);
  assert.deepEqual(ageChecked, [], "no mtime stat on a launching worktree");
});

test("sweepOrphanWorktrees spares a resolved (merged/closed) worktree", async () => {
  const { deps, reattached } = sweepDeps({
    worktrees: [wt("eng-1-a")],
    resolved: new Set(["eng-1-a"]),
  });
  await sweepOrphanWorktrees(deps);
  assert.deepEqual(reattached, []);
});

test("sweepOrphanWorktrees spares a worktree younger than minAgeMs", async () => {
  const { deps, reattached } = sweepDeps({ worktrees: [wt("eng-1-a")], young: new Set(["eng-1-a"]) });
  await sweepOrphanWorktrees(deps);
  assert.deepEqual(reattached, []);
});

test("sweepOrphanWorktrees spares a split-group slice", async () => {
  const { deps, reattached } = sweepDeps({
    worktrees: [wt("eng-1"), wt("eng-1-p1")],
    parents: { [`${WT}/eng-1-p1`]: "eng-1" },
  });
  await sweepOrphanWorktrees(deps);
  assert.equal(reattached.includes("eng-1-p1"), false, "the slice is spared");
});

test("sweepOrphanWorktrees ignores worktrees outside the worktrees dir", async () => {
  const { deps, reattached } = sweepDeps({
    worktrees: [{ path: "/home/ymbo/Work/gemini", branch: "main" }],
  });
  await sweepOrphanWorktrees(deps);
  assert.deepEqual(reattached, []);
});

test("sweepOrphanWorktrees continues to other worktrees when one relaunch throws", async () => {
  const attempted: string[] = [];
  const { deps, logs } = sweepDeps({
    worktrees: [wt("eng-1-a"), wt("eng-2-b")],
    reattach: (b) => {
      attempted.push(b);
      if (b === "eng-1-a") throw new Error("relaunch failed");
    },
  });
  await sweepOrphanWorktrees(deps);
  assert.deepEqual(attempted, ["eng-1-a", "eng-2-b"]);
  assert.ok(logs.some((l) => /relaunch failed/.test(l)));
});

test("sweepOrphanWorktrees swallows a listWorktrees failure without reattaching", async () => {
  const { deps, reattached, logs } = sweepDeps({ worktrees: [] });
  deps.listWorktrees = () => {
    throw new Error("git 128");
  };
  await sweepOrphanWorktrees(deps);
  assert.deepEqual(reattached, []);
  assert.ok(logs.some((l) => /git 128/.test(l)));
});

test("sweepOrphanWorktrees defers (no reattach) when the resolved-PR fetch fails", async () => {
  const { deps, reattached, logs } = sweepDeps({
    worktrees: [wt("eng-1-a")],
    resolvedBranches: async () => {
      throw new Error("gh down");
    },
  });
  await sweepOrphanWorktrees(deps);
  assert.deepEqual(reattached, [], "a resolved worktree must never be resurrected on a fetch error");
  assert.ok(logs.some((l) => /gh down/.test(l)));
});

test("sweepOrphanWorktrees is a no-op on an empty worktree list", async () => {
  const { deps, reattached } = sweepDeps({ worktrees: [] });
  await sweepOrphanWorktrees(deps);
  assert.deepEqual(reattached, []);
});

function opr(number: number, headRefName = `eng-${number}-x`): OpenPR {
  return { number, headRefName, isDraft: false };
}

function mpr(number: number, headRefName = `eng-${number}-x`): MergedPR {
  return { number, headRefName };
}

function deps(overrides: Partial<CleanupDeps> = {}): {
  deps: CleanupDeps;
  torn: string[];
  killed: string[];
  logs: string[];
} {
  const torn: string[] = [];
  const killed: string[] = [];
  const logs: string[] = [];
  const d: CleanupDeps = {
    listWorktrees: () => [wt("eng-1-a"), wt("eng-2-b")],
    listMergedPRs: async () => [mpr(2, "eng-2-b")],
    listClosedUnmergedPRs: async () => [],
    listOpenPRs: async () => [],
    issueStateType: async () => null,
    hasNoUnpushedWork: () => true,
    worktreesDir: WT,
    teardown: (branch) => void torn.push(branch),
    listSessions: () => [],
    killSession: (s) => void killed.push(s),
    readParentSession: () => null,
    hasActiveSplitWindows: () => false,
    isSplitParent: () => false,
    log: (m) => void logs.push(m),
    ...overrides,
  };
  return { deps: d, torn, killed, logs };
}

test("cleanupOnce hands the merged branch set to reconcileMerged, even with no worktree present", async () => {
  let seen: Set<string> | null = null;
  const { deps: d } = deps({
    listWorktrees: () => [], // worktree already gone
    listMergedPRs: async () => [mpr(2, "eng-2-b"), mpr(3, "eng-3-c")],
    reconcileMerged: (branches) => void (seen = branches),
  });
  await cleanupOnce(d);
  assert.ok(seen, "reconcileMerged was called");
  assert.deepEqual([...(seen as unknown as Set<string>)].sort(), ["eng-2-b", "eng-3-c"]);
});

test("cleanupOnce still reconciles merged branches when a later teardown throws", async () => {
  let seen: Set<string> | null = null;
  const { deps: d } = deps({
    reconcileMerged: (branches) => void (seen = branches),
    teardown: () => {
      throw new Error("boom");
    },
  });
  await cleanupOnce(d);
  assert.deepEqual([...(seen as unknown as Set<string>)], ["eng-2-b"]);
});

test("cleanupOnce tears down each merged worktree", async () => {
  const { deps: d, torn } = deps();
  await cleanupOnce(d);
  assert.deepEqual(torn, ["eng-2-b"]);
});

test("cleanupOnce tears down nothing when no branch merged", async () => {
  const { deps: d, torn } = deps({ listMergedPRs: async () => [] });
  await cleanupOnce(d);
  assert.equal(torn.length, 0);
});

test("cleanupOnce kills a merged PR's pr-<n>-fix session even when its worktree is gone", async () => {
  const { deps: d, torn, killed } = deps({
    listWorktrees: () => [], // worktree already removed
    listMergedPRs: async () => [mpr(4730, "fix/flaky-comments-and-recommendations-test")],
    listSessions: () => ["pr-4730-fix", "work-session"],
  });
  await cleanupOnce(d);
  assert.deepEqual(torn, [], "no worktree to tear down");
  assert.deepEqual(killed, ["pr-4730-fix"], "the fix session is killed directly");
});

test("cleanupOnce tears down the worktree AND kills the fix session when both present", async () => {
  const { deps: d, torn, killed } = deps({
    listWorktrees: () => [wt("fix-flaky", "/home/ymbo/Work/worktrees/fix-flaky")],
    listMergedPRs: async () => [mpr(4730, "fix-flaky")],
    listSessions: () => ["pr-4730-fix"],
  });
  await cleanupOnce(d);
  assert.deepEqual(torn, ["fix-flaky"]);
  assert.deepEqual(killed, ["pr-4730-fix"]);
});

test("cleanupOnce leaves fix sessions of unmerged PRs running", async () => {
  const { deps: d, killed } = deps({
    listWorktrees: () => [],
    listMergedPRs: async () => [mpr(4730, "eng-x")],
    listSessions: () => ["pr-9999-fix"], // 9999 not merged
  });
  await cleanupOnce(d);
  assert.deepEqual(killed, []);
});

test("cleanupOnce swallows a listWorktrees failure without tearing down", async () => {
  const { deps: d, torn, logs } = deps({
    listWorktrees: () => {
      throw new Error("git 128");
    },
  });
  await cleanupOnce(d);
  assert.equal(torn.length, 0);
  assert.ok(logs.some((l) => /git 128/.test(l)));
});

test("cleanupOnce swallows a listMergedPRs failure without tearing down", async () => {
  const { deps: d, torn, logs } = deps({
    listMergedPRs: async () => {
      throw new Error("gh 500");
    },
  });
  await cleanupOnce(d);
  assert.equal(torn.length, 0);
  assert.ok(logs.some((l) => /gh 500/.test(l)));
});

test("cleanupOnce swallows a listSessions failure without killing", async () => {
  const { deps: d, killed, logs } = deps({
    listSessions: () => {
      throw new Error("tmux gone");
    },
  });
  await cleanupOnce(d);
  assert.equal(killed.length, 0);
  assert.ok(logs.some((l) => /tmux gone/.test(l)));
});

test("cleanupOnce continues to other worktrees when one teardown throws", async () => {
  const attempted: string[] = [];
  const { deps: d, logs } = deps({
    listMergedPRs: async () => [mpr(1, "eng-1-a"), mpr(2, "eng-2-b")],
    teardown: (branch) => {
      attempted.push(branch);
      if (branch === "eng-1-a") throw new Error("docker down failed");
    },
  });
  await cleanupOnce(d);
  assert.deepEqual(attempted, ["eng-1-a", "eng-2-b"]);
  assert.ok(logs.some((l) => /docker down failed/.test(l)));
});

test("cleanupOnce continues to other fix sessions when one kill throws", async () => {
  const attempted: string[] = [];
  const { deps: d, logs } = deps({
    listWorktrees: () => [],
    listMergedPRs: async () => [mpr(1), mpr(2)],
    listSessions: () => ["pr-1-fix", "pr-2-fix"],
    killSession: (s) => {
      attempted.push(s);
      if (s === "pr-1-fix") throw new Error("kill failed");
    },
  });
  await cleanupOnce(d);
  assert.deepEqual(attempted, ["pr-1-fix", "pr-2-fix"]);
  assert.ok(logs.some((l) => /kill failed/.test(l)));
});

test("cleanupOnce tears down a closed-unmerged worktree when it is fully pushed", async () => {
  const { deps: d, torn } = deps({
    listWorktrees: () => [wt("eng-1104-spike")],
    listMergedPRs: async () => [],
    listClosedUnmergedPRs: async () => [mpr(4880, "eng-1104-spike")],
    hasNoUnpushedWork: () => true,
  });
  await cleanupOnce(d);
  assert.deepEqual(torn, ["eng-1104-spike"]);
});

test("cleanupOnce keeps a closed-unmerged worktree that has unpushed work", async () => {
  const { deps: d, torn, logs } = deps({
    listWorktrees: () => [wt("eng-1104-spike")],
    listMergedPRs: async () => [],
    listClosedUnmergedPRs: async () => [mpr(4880, "eng-1104-spike")],
    hasNoUnpushedWork: () => false,
  });
  await cleanupOnce(d);
  assert.deepEqual(torn, []);
  assert.ok(logs.some((l) => /eng-1104-spike/.test(l) && /unsaved work/.test(l)));
});

test("cleanupOnce only runs the unpushed-work check on closed-unmerged branches", async () => {
  const checked: string[] = [];
  const { deps: d } = deps({
    listWorktrees: () => [wt("eng-1-a"), wt("eng-2-b"), wt("eng-1104-spike")],
    listMergedPRs: async () => [mpr(2, "eng-2-b")],
    listClosedUnmergedPRs: async () => [mpr(4880, "eng-1104-spike")],
    hasNoUnpushedWork: (path) => {
      checked.push(path.slice(path.lastIndexOf("/") + 1));
      return true;
    },
  });
  await cleanupOnce(d);
  assert.deepEqual(checked, ["eng-1104-spike"]);
});

test("cleanupOnce leaves a closed-unmerged slice of a split group alone", async () => {
  const { deps: d, torn } = deps({
    listWorktrees: () => [
      { path: `${WT}/eng-1`, branch: "eng-1" },
      { path: `${WT}/eng-1-p1`, branch: "eng-1-p1" },
    ],
    readParentSession: (p) => (p === `${WT}/eng-1-p1` ? "eng-1" : null),
    listMergedPRs: async () => [],
    listClosedUnmergedPRs: async () => [mpr(4880, "eng-1-p1")],
    hasNoUnpushedWork: () => true,
  });
  await cleanupOnce(d);
  assert.deepEqual(torn, []);
});

test("cleanupOnce does not reap a split's integration worktree when its dir differs from the session name", async () => {
  // The original ticket PR is closed after the split. The integration worktree
  // dir is the sanitized session name, while the slice marker holds the full one.
  // It must still be grouped (and so spared), not torn down by the closed path.
  const session = "eng-1104-a-really-long-descriptive-ticket-title-exceeding-fifty";
  const dir = sanitizeBranchToSession(session);
  const { deps: d, torn } = deps({
    listWorktrees: () => [
      { path: `${WT}/${dir}`, branch: dir },
      { path: `${WT}/eng-1104-p1`, branch: "eng-1104-p1" },
    ],
    readParentSession: (p) => (p === `${WT}/eng-1104-p1` ? session : null),
    listMergedPRs: async () => [],
    listClosedUnmergedPRs: async () => [mpr(4880, dir)],
    hasNoUnpushedWork: () => true,
  });
  await cleanupOnce(d);
  assert.equal(torn.includes(dir), false, "integration worktree is spared");
});

test("cleanupOnce keeps a closed-unmerged worktree whose session still has active split slice windows", async () => {
  // A heartbeat lands while a split is in progress but the slice markers are not
  // yet visible (race or transient marker-read failure): the split parent's PR is
  // closed and ungrouped, but its live "PR (i/n)" windows must still spare it.
  const { deps: d, torn, logs } = deps({
    listWorktrees: () => [wt("eng-1")],
    listMergedPRs: async () => [],
    listClosedUnmergedPRs: async () => [mpr(10, "eng-1")],
    hasNoUnpushedWork: () => true,
    readParentSession: () => null,
    hasActiveSplitWindows: (w) => w.branch === "eng-1",
  });
  await cleanupOnce(d);
  assert.deepEqual(torn, []);
  assert.ok(logs.some((l) => /eng-1/.test(l) && /split/.test(l)));
});

test("cleanupOnce keeps a closed-unmerged worktree flagged as a split parent", async () => {
  // The ticket branch had a PR that was closed to start a split, but no slice
  // worktrees/windows exist yet (the pre-first-slice race). The durable
  // .yimbot-split-parent marker, written before the PR is closed, spares it.
  const { deps: d, torn, logs } = deps({
    listWorktrees: () => [wt("eng-1")],
    listMergedPRs: async () => [],
    listClosedUnmergedPRs: async () => [mpr(10, "eng-1")],
    hasNoUnpushedWork: () => true,
    hasActiveSplitWindows: () => false,
    isSplitParent: (p) => p === `${WT}/eng-1`,
  });
  await cleanupOnce(d);
  assert.deepEqual(torn, []);
  assert.ok(logs.some((l) => /eng-1/.test(l) && /split/.test(l)));
});

test("cleanupOnce still reaps a plain closed-unmerged spike (no split windows)", async () => {
  const { deps: d, torn } = deps({
    listWorktrees: () => [wt("eng-1104-spike")],
    listMergedPRs: async () => [],
    listClosedUnmergedPRs: async () => [mpr(4880, "eng-1104-spike")],
    hasNoUnpushedWork: () => true,
    hasActiveSplitWindows: () => false,
  });
  await cleanupOnce(d);
  assert.deepEqual(torn, ["eng-1104-spike"]);
});

test("cleanupOnce still reaps merged worktrees when the closed-PR list fails", async () => {
  const { deps: d, torn, logs } = deps({
    listWorktrees: () => [wt("eng-2-b")],
    listMergedPRs: async () => [mpr(2, "eng-2-b")],
    listClosedUnmergedPRs: async () => {
      throw new Error("gh 503");
    },
  });
  await cleanupOnce(d);
  assert.deepEqual(torn, ["eng-2-b"]);
  assert.ok(logs.some((l) => /gh 503/.test(l)));
});

test("cleanupOnce reaps a no-PR worktree once its ticket completes", async () => {
  const { deps: d, torn, logs } = deps({
    listWorktrees: () => [wt("eng-1104-spike")],
    listMergedPRs: async () => [],
    issueStateType: async (id) => (id === "ENG-1104" ? "completed" : null),
  });
  await cleanupOnce(d);
  assert.deepEqual(torn, ["eng-1104-spike"]);
  assert.ok(logs.some((l) => /eng-1104-spike/.test(l) && /no PR/.test(l)));
});

test("cleanupOnce reaps a no-PR worktree once its ticket is canceled", async () => {
  const { deps: d, torn } = deps({
    listWorktrees: () => [wt("eng-1104-spike")],
    listMergedPRs: async () => [],
    issueStateType: async () => "canceled",
  });
  await cleanupOnce(d);
  assert.deepEqual(torn, ["eng-1104-spike"]);
});

test("cleanupOnce leaves a no-PR worktree alone while its ticket is non-terminal", async () => {
  const { deps: d, torn } = deps({
    listWorktrees: () => [wt("eng-1104-spike")],
    listMergedPRs: async () => [],
    issueStateType: async () => "started",
  });
  await cleanupOnce(d);
  assert.deepEqual(torn, []);
});

test("cleanupOnce spares a completed ticket's worktree while its PR is still open", async () => {
  const { deps: d, torn } = deps({
    listWorktrees: () => [wt("eng-1104-spike")],
    listMergedPRs: async () => [],
    listOpenPRs: async () => [opr(4880, "eng-1104-spike")],
    issueStateType: async () => "completed",
  });
  await cleanupOnce(d);
  assert.deepEqual(torn, []);
});

test("cleanupOnce keeps a completed no-PR worktree that has unpushed work", async () => {
  const { deps: d, torn, logs } = deps({
    listWorktrees: () => [wt("eng-1104-spike")],
    listMergedPRs: async () => [],
    issueStateType: async () => "completed",
    hasNoUnpushedWork: () => false,
  });
  await cleanupOnce(d);
  assert.deepEqual(torn, []);
  assert.ok(logs.some((l) => /eng-1104-spike/.test(l) && /unsaved work/.test(l)));
});

test("cleanupOnce never looks up a branch that maps to no issue", async () => {
  const looked: string[] = [];
  const { deps: d, torn } = deps({
    listWorktrees: () => [wt("experiment-scratch")],
    listMergedPRs: async () => [],
    issueStateType: async (id) => {
      looked.push(id);
      return "completed";
    },
  });
  await cleanupOnce(d);
  assert.deepEqual(looked, []);
  assert.deepEqual(torn, []);
});

test("cleanupOnce skips the no-PR reap when the open PR list fails", async () => {
  const { deps: d, torn, logs } = deps({
    listWorktrees: () => [wt("eng-1104-spike")],
    listMergedPRs: async () => [],
    listOpenPRs: async () => {
      throw new Error("gh 503");
    },
    issueStateType: async () => "completed",
  });
  await cleanupOnce(d);
  assert.deepEqual(torn, []);
  assert.ok(logs.some((l) => /gh 503/.test(l)));
});

test("cleanupOnce skips the no-PR reap when the closed PR list fails", async () => {
  // With the closed set unknown, a closed-PR worktree would masquerade as no-PR;
  // the merged path still runs, but the no-PR reap must sit the tick out.
  const { deps: d, torn } = deps({
    listWorktrees: () => [wt("eng-1104-spike")],
    listMergedPRs: async () => [],
    listClosedUnmergedPRs: async () => {
      throw new Error("gh 503");
    },
    issueStateType: async () => "completed",
  });
  await cleanupOnce(d);
  assert.deepEqual(torn, []);
});

test("cleanupOnce keeps a no-PR worktree when the issue state lookup fails", async () => {
  const { deps: d, torn, logs } = deps({
    listWorktrees: () => [wt("eng-1104-spike")],
    listMergedPRs: async () => [],
    issueStateType: async () => {
      throw new Error("linear 500");
    },
  });
  await cleanupOnce(d);
  assert.deepEqual(torn, []);
  assert.ok(logs.some((l) => /ENG-1104/.test(l) && /linear 500/.test(l)));
});

test("cleanupOnce never reaps an AC-continuation worktree, even with its issue completed", async () => {
  // The advance step spawns eng-<n>-cont-<k> continuations for an issue whose PR
  // already merged; the issue may be Done (auto-transitioned on merge, or closed
  // by a human) while the continuation is still working with a clean tree. Its
  // branch maps to the same ENG-<n>, so without a guard the no-PR reap would
  // kill it mid-work.
  const looked: string[] = [];
  const { deps: d, torn } = deps({
    listWorktrees: () => [wt("eng-42-cont-1")],
    listMergedPRs: async () => [],
    issueStateType: async (id) => {
      looked.push(id);
      return "completed";
    },
  });
  await cleanupOnce(d);
  assert.deepEqual(torn, []);
  assert.deepEqual(looked, []);
});

test("cleanupOnce spares a completed no-PR worktree flagged as a split parent", async () => {
  const { deps: d, torn, logs } = deps({
    listWorktrees: () => [wt("eng-1104-spike")],
    listMergedPRs: async () => [],
    issueStateType: async () => "completed",
    isSplitParent: (p) => p === `${WT}/eng-1104-spike`,
  });
  await cleanupOnce(d);
  assert.deepEqual(torn, []);
  assert.ok(logs.some((l) => /eng-1104-spike/.test(l) && /split/.test(l)));
});

test("isSplitSliceWindow recognizes the 'PR (i/n)' window split-pr.sh creates", () => {
  assert.equal(isSplitSliceWindow("PR (1/2)"), true);
  assert.equal(isSplitSliceWindow("PR (10/12)"), true);
  assert.equal(isSplitSliceWindow(" PR (1/2) "), true);
});

test("isSplitSliceWindow rejects ordinary window names", () => {
  assert.equal(isSplitSliceWindow("Claude"), false);
  assert.equal(isSplitSliceWindow("pr-4730-fix"), false);
  assert.equal(isSplitSliceWindow("PR"), false);
  assert.equal(isSplitSliceWindow("PR (a/b)"), false);
});

// parentOf map helper: slice worktree path -> parent session name.
function parentOfMap(m: Record<string, string>) {
  return (path: string): string | null => m[path] ?? null;
}

test("buildSplitGroups groups slices with their integration worktree", () => {
  const worktrees: Worktree[] = [
    { path: `${WT}/eng-1`, branch: "eng-1" }, // integration (no marker)
    { path: `${WT}/eng-1-part-1`, branch: "eng-1-part-1" },
    { path: `${WT}/eng-1-part-2`, branch: "eng-1-part-2" },
    { path: `${WT}/eng-2`, branch: "eng-2" }, // unrelated normal ticket
  ];
  const parentOf = parentOfMap({
    [`${WT}/eng-1-part-1`]: "eng-1",
    [`${WT}/eng-1-part-2`]: "eng-1",
  });
  const groups = buildSplitGroups(worktrees, parentOf, WT);
  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.equal(g.session, "eng-1");
  assert.equal(g.integrationBranch, "eng-1");
  assert.deepEqual([...g.sliceBranches].sort(), ["eng-1-part-1", "eng-1-part-2"]);
  assert.equal(g.worktreePaths.length, 3);
});

test("buildSplitGroups matches the integration worktree when the session name differs from its truncated dir", () => {
  // A long/special session name: the tmux session keeps the full name while the
  // worktree dir is the sanitized, 50-char form. The slice marker holds the full
  // session name, so an exact-path lookup would miss the integration worktree.
  const session = "eng-1104-a-really-long-descriptive-ticket-title-exceeding-fifty";
  const dir = sanitizeBranchToSession(session);
  assert.notEqual(dir, session, "precondition: dir differs from the raw session name");
  const worktrees: Worktree[] = [
    { path: `${WT}/${dir}`, branch: dir }, // integration (no marker)
    { path: `${WT}/eng-1104-p1`, branch: "eng-1104-p1" },
  ];
  const parentOf = parentOfMap({ [`${WT}/eng-1104-p1`]: session });
  const groups = buildSplitGroups(worktrees, parentOf, WT);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].integrationBranch, dir);
  assert.equal(groups[0].worktreePaths.length, 2);
});

test("buildSplitGroups tolerates a missing integration worktree", () => {
  const worktrees: Worktree[] = [{ path: `${WT}/eng-1-part-1`, branch: "eng-1-part-1" }];
  const parentOf = parentOfMap({ [`${WT}/eng-1-part-1`]: "eng-1" });
  const groups = buildSplitGroups(worktrees, parentOf, WT);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].integrationBranch, null);
  assert.deepEqual(groups[0].sliceBranches, ["eng-1-part-1"]);
});

test("groupReady is true only when every slice branch is merged", () => {
  const g: SplitGroup = {
    session: "eng-1",
    integrationBranch: "eng-1",
    integration: null,
    sliceBranches: ["eng-1-part-1", "eng-1-part-2"],
    slices: [],
    worktreePaths: [],
  };
  assert.equal(groupReady(g, new Set(["eng-1-part-1"])), false);
  assert.equal(groupReady(g, new Set(["eng-1-part-1", "eng-1-part-2"])), true);
  // Integration branch merging is irrelevant; it has no PR.
  assert.equal(groupReady(g, new Set(["eng-1"])), false);
});

test("groupReady is ready when every slice is merged OR closed-unmerged", () => {
  const g: SplitGroup = {
    session: "eng-1",
    integrationBranch: "eng-1",
    integration: null,
    sliceBranches: ["eng-1-p1", "eng-1-p2"],
    slices: [],
    worktreePaths: [],
  };
  // one merged, one closed → resolved → ready
  assert.equal(groupReady(g, new Set(["eng-1-p1"]), new Set(["eng-1-p2"])), true);
  // one merged, one still open → not ready
  assert.equal(groupReady(g, new Set(["eng-1-p1"]), new Set()), false);
  // all closed, none merged → mid-split or abandoned → left alone, not ready
  assert.equal(groupReady(g, new Set(), new Set(["eng-1-p1", "eng-1-p2"])), false);
});

test("groupReady is false for a group with no slices", () => {
  const g: SplitGroup = {
    session: "x",
    integrationBranch: "x",
    integration: null,
    sliceBranches: [],
    slices: [],
    worktreePaths: [],
  };
  assert.equal(groupReady(g, new Set()), false);
});

function recorderDeps(over: Partial<CleanupDeps> & {
  worktrees: Worktree[];
  merged: MergedPR[];
  parents?: Record<string, string>;
  sessions?: string[];
}): { deps: CleanupDeps; tornDown: string[]; killed: string[] } {
  const tornDown: string[] = [];
  const killed: string[] = [];
  const deps: CleanupDeps = {
    listWorktrees: () => over.worktrees,
    listMergedPRs: async () => over.merged,
    listClosedUnmergedPRs: async () => [],
    listOpenPRs: async () => [],
    issueStateType: async () => null,
    hasNoUnpushedWork: () => true,
    worktreesDir: WT,
    teardown: (b) => tornDown.push(b),
    listSessions: () => over.sessions ?? [],
    killSession: (s) => killed.push(s),
    readParentSession: (p) => over.parents?.[p] ?? null,
    hasActiveSplitWindows: over.hasActiveSplitWindows ?? (() => false),
    isSplitParent: over.isSplitParent ?? (() => false),
    log: () => {},
  };
  return { deps, tornDown, killed };
}

test("cleanupOnce tears down a fully-merged split group and its integration branch", async () => {
  const { deps, tornDown } = recorderDeps({
    worktrees: [
      { path: `${WT}/eng-1`, branch: "eng-1" },
      { path: `${WT}/eng-1-p1`, branch: "eng-1-p1" },
      { path: `${WT}/eng-1-p2`, branch: "eng-1-p2" },
    ],
    parents: { [`${WT}/eng-1-p1`]: "eng-1", [`${WT}/eng-1-p2`]: "eng-1" },
    merged: [mpr(1, "eng-1-p1"), mpr(2, "eng-1-p2")],
  });
  await cleanupOnce(deps);
  assert.deepEqual([...tornDown].sort(), ["eng-1", "eng-1-p1", "eng-1-p2"]);
});

test("cleanupOnce leaves a partially-merged split group entirely alone", async () => {
  const { deps, tornDown } = recorderDeps({
    worktrees: [
      { path: `${WT}/eng-1`, branch: "eng-1" },
      { path: `${WT}/eng-1-p1`, branch: "eng-1-p1" },
      { path: `${WT}/eng-1-p2`, branch: "eng-1-p2" },
    ],
    parents: { [`${WT}/eng-1-p1`]: "eng-1", [`${WT}/eng-1-p2`]: "eng-1" },
    merged: [mpr(1, "eng-1-p1")], // only one slice merged
  });
  await cleanupOnce(deps);
  assert.deepEqual(tornDown, []); // the merged slice is NOT torn down early
});

test("cleanupOnce still tears down a normal (non-split) merged worktree", async () => {
  const { deps, tornDown } = recorderDeps({
    worktrees: [{ path: `${WT}/eng-9`, branch: "eng-9" }],
    merged: [mpr(9, "eng-9")],
  });
  await cleanupOnce(deps);
  assert.deepEqual(tornDown, ["eng-9"]);
});

test("cleanupOnce kills the session directly when the integration worktree is gone", async () => {
  const { deps, tornDown, killed } = recorderDeps({
    worktrees: [{ path: `${WT}/eng-1-p1`, branch: "eng-1-p1" }],
    parents: { [`${WT}/eng-1-p1`]: "eng-1" },
    merged: [mpr(1, "eng-1-p1")],
  });
  await cleanupOnce(deps);
  assert.deepEqual(tornDown, ["eng-1-p1"]);
  assert.deepEqual(killed, ["eng-1"]);
});

test("cleanupOnce tears down a split group when one slice merged and the other was closed unmerged", async () => {
  const { deps: d, torn } = deps({
    listWorktrees: () => [
      { path: `${WT}/eng-1`, branch: "eng-1" },
      { path: `${WT}/eng-1-p1`, branch: "eng-1-p1" },
      { path: `${WT}/eng-1-p2`, branch: "eng-1-p2" },
    ],
    readParentSession: (p) =>
      p === `${WT}/eng-1-p1` || p === `${WT}/eng-1-p2` ? "eng-1" : null,
    listMergedPRs: async () => [mpr(1, "eng-1-p1")],
    listClosedUnmergedPRs: async () => [mpr(2, "eng-1-p2")],
    hasNoUnpushedWork: () => true,
  });
  await cleanupOnce(d);
  assert.deepEqual([...torn].sort(), ["eng-1", "eng-1-p1", "eng-1-p2"]);
});

test("cleanupOnce keeps the whole group when a closed slice has unsaved work", async () => {
  const { deps: d, torn, logs } = deps({
    listWorktrees: () => [
      { path: `${WT}/eng-1`, branch: "eng-1" },
      { path: `${WT}/eng-1-p1`, branch: "eng-1-p1" },
      { path: `${WT}/eng-1-p2`, branch: "eng-1-p2" },
    ],
    readParentSession: (p) =>
      p === `${WT}/eng-1-p1` || p === `${WT}/eng-1-p2` ? "eng-1" : null,
    listMergedPRs: async () => [mpr(1, "eng-1-p1")],
    listClosedUnmergedPRs: async () => [mpr(2, "eng-1-p2")],
    hasNoUnpushedWork: (p) => p !== `${WT}/eng-1-p2`, // the closed slice has local work
  });
  await cleanupOnce(d);
  assert.deepEqual(torn, []);
  assert.ok(logs.some((l) => /eng-1/.test(l) && /unsaved/.test(l)));
});

test("cleanupOnce keeps the whole group when the integration worktree has unsaved work", async () => {
  const { deps: d, torn } = deps({
    listWorktrees: () => [
      { path: `${WT}/eng-1`, branch: "eng-1" },
      { path: `${WT}/eng-1-p1`, branch: "eng-1-p1" },
      { path: `${WT}/eng-1-p2`, branch: "eng-1-p2" },
    ],
    readParentSession: (p) =>
      p === `${WT}/eng-1-p1` || p === `${WT}/eng-1-p2` ? "eng-1" : null,
    listMergedPRs: async () => [mpr(1, "eng-1-p1")],
    listClosedUnmergedPRs: async () => [mpr(2, "eng-1-p2")],
    hasNoUnpushedWork: (p) => p !== `${WT}/eng-1`, // integration worktree has local work
  });
  await cleanupOnce(d);
  assert.deepEqual(torn, []);
});

test("cleanupOnce does not gate a merged slice whose upstream is gone (branch deleted on merge)", async () => {
  // A fully-merged group must still tear down even if a merged slice reports "not
  // fully pushed" — its origin branch was deleted on merge, so @{upstream} fails.
  // Only closed slices and the integration worktree are gated.
  const { deps: d, torn } = deps({
    listWorktrees: () => [
      { path: `${WT}/eng-1`, branch: "eng-1" },
      { path: `${WT}/eng-1-p1`, branch: "eng-1-p1" },
      { path: `${WT}/eng-1-p2`, branch: "eng-1-p2" },
    ],
    readParentSession: (p) =>
      p === `${WT}/eng-1-p1` || p === `${WT}/eng-1-p2` ? "eng-1" : null,
    listMergedPRs: async () => [mpr(1, "eng-1-p1"), mpr(2, "eng-1-p2")],
    listClosedUnmergedPRs: async () => [],
    hasNoUnpushedWork: (p) => p !== `${WT}/eng-1-p1`, // merged slice's branch gone
  });
  await cleanupOnce(d);
  assert.deepEqual([...torn].sort(), ["eng-1", "eng-1-p1", "eng-1-p2"]);
});

test("readParentSession returns null when marker file is missing", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "yimbot-wt-"));
  try {
    assert.equal(readParentSession(tempDir), null);
  } finally {
    rmSync(tempDir, { recursive: true });
  }
});

test("readParentSession returns trimmed session name when marker is present", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "yimbot-wt-"));
  try {
    writeFileSync(join(tempDir, ".yimbot-parent-session"), "eng-1\n");
    assert.equal(readParentSession(tempDir), "eng-1");
  } finally {
    rmSync(tempDir, { recursive: true });
  }
});

test("readParentSession returns null when marker file is empty", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "yimbot-wt-"));
  try {
    writeFileSync(join(tempDir, ".yimbot-parent-session"), "");
    assert.equal(readParentSession(tempDir), null);
  } finally {
    rmSync(tempDir, { recursive: true });
  }
});
