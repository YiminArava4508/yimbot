import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CleanupDeps,
  cleanupOnce,
  selectMergedFixSessions,
  selectMergedWorktrees,
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
