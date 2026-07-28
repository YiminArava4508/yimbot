import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSplitGroups,
  type CleanupDeps,
  cleanupOnce,
  groupReady,
  selectMergedFixSessions,
  selectMergedWorktrees,
  type SplitGroup,
  type Worktree,
} from "./cleanup.ts";
import type { MergedPR } from "./gh.ts";

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
    worktreesDir: WT,
    teardown: (branch) => void torn.push(branch),
    listSessions: () => [],
    killSession: (s) => void killed.push(s),
    readParentSession: () => null,
    log: (m) => void logs.push(m),
    ...overrides,
  };
  return { deps: d, torn, killed, logs };
}

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
    sliceBranches: ["eng-1-part-1", "eng-1-part-2"],
    worktreePaths: [],
  };
  assert.equal(groupReady(g, new Set(["eng-1-part-1"])), false);
  assert.equal(groupReady(g, new Set(["eng-1-part-1", "eng-1-part-2"])), true);
  // Integration branch merging is irrelevant; it has no PR.
  assert.equal(groupReady(g, new Set(["eng-1"])), false);
});

test("groupReady is false for a group with no slices", () => {
  const g: SplitGroup = { session: "x", integrationBranch: "x", sliceBranches: [], worktreePaths: [] };
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
    worktreesDir: WT,
    teardown: (b) => tornDown.push(b),
    listSessions: () => over.sessions ?? [],
    killSession: (s) => killed.push(s),
    readParentSession: (p) => over.parents?.[p] ?? null,
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
