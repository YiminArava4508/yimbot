import assert from "node:assert/strict";
import { test } from "node:test";
import { type CleanupDeps, cleanupOnce, selectMergedWorktrees, type Worktree } from "./cleanup.ts";

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

function deps(overrides: Partial<CleanupDeps> = {}): {
  deps: CleanupDeps;
  torn: string[];
  logs: string[];
} {
  const torn: string[] = [];
  const logs: string[] = [];
  const d: CleanupDeps = {
    listWorktrees: () => [wt("eng-1-a"), wt("eng-2-b")],
    listMergedBranches: () => new Set(["eng-2-b"]),
    worktreesDir: WT,
    teardown: (branch) => void torn.push(branch),
    log: (m) => void logs.push(m),
    ...overrides,
  };
  return { deps: d, torn, logs };
}

test("cleanupOnce tears down each merged worktree", () => {
  const { deps: d, torn } = deps();
  cleanupOnce(d);
  assert.deepEqual(torn, ["eng-2-b"]);
});

test("cleanupOnce tears down nothing when no branch merged", () => {
  const { deps: d, torn } = deps({ listMergedBranches: () => new Set() });
  cleanupOnce(d);
  assert.equal(torn.length, 0);
});

test("cleanupOnce swallows a listWorktrees failure without tearing down", () => {
  const { deps: d, torn, logs } = deps({
    listWorktrees: () => {
      throw new Error("git 128");
    },
  });
  cleanupOnce(d);
  assert.equal(torn.length, 0);
  assert.ok(logs.some((l) => /git 128/.test(l)));
});

test("cleanupOnce swallows a listMergedBranches failure without tearing down", () => {
  const { deps: d, torn, logs } = deps({
    listMergedBranches: () => {
      throw new Error("gh 500");
    },
  });
  cleanupOnce(d);
  assert.equal(torn.length, 0);
  assert.ok(logs.some((l) => /gh 500/.test(l)));
});

test("cleanupOnce continues to other worktrees when one teardown throws", () => {
  const attempted: string[] = [];
  const { deps: d, logs } = deps({
    listMergedBranches: () => new Set(["eng-1-a", "eng-2-b"]),
    teardown: (branch) => {
      attempted.push(branch);
      if (branch === "eng-1-a") throw new Error("docker down failed");
    },
  });
  cleanupOnce(d);
  assert.deepEqual(attempted, ["eng-1-a", "eng-2-b"]);
  assert.ok(logs.some((l) => /docker down failed/.test(l)));
});
