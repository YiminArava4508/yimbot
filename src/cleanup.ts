export type Worktree = { path: string; branch: string };

export type CleanupDeps = {
  // Live git worktrees (any location; filtered here to the worktrees dir).
  listWorktrees: () => Worktree[];
  // Head-branch names of the viewer's merged PRs.
  listMergedBranches: () => Set<string>;
  // Only worktrees under this directory are torn down, so the main checkout is
  // never touched even if a branch name somehow collides.
  worktreesDir: string;
  // Tear down a worktree by its branch (== its session name): docker down,
  // worktree remove, branch delete, kill session. Delegates to end-session.sh.
  teardown: (branch: string) => void;
  log: (msg: string) => void;
};

// Worktrees to tear down: branch is in the merged set AND the worktree lives
// under worktreesDir. The path filter keeps the main checkout (and any unrelated
// worktree) out even if its branch name matched a merged PR.
export function selectMergedWorktrees(
  worktrees: Worktree[],
  mergedBranches: Set<string>,
  worktreesDir: string,
): Worktree[] {
  const prefix = worktreesDir.endsWith("/") ? worktreesDir : `${worktreesDir}/`;
  return worktrees.filter((w) => mergedBranches.has(w.branch) && w.path.startsWith(prefix));
}

// One cleanup-step tick, run every heartbeat. Tear down the worktree + session of
// each of the viewer's merged PRs. No seen-set: worktree-first scanning is
// self-deduping (a removed worktree is simply gone next tick). Every external
// call is wrapped so a failure logs and continues, never crashing the heartbeat.
export function cleanupOnce(deps: CleanupDeps): void {
  let worktrees: Worktree[];
  try {
    worktrees = deps.listWorktrees();
  } catch (err) {
    deps.log(`worktree list failed: ${err}`);
    return;
  }

  let merged: Set<string>;
  try {
    merged = deps.listMergedBranches();
  } catch (err) {
    deps.log(`merged PR list failed: ${err}`);
    return;
  }

  for (const w of selectMergedWorktrees(worktrees, merged, deps.worktreesDir)) {
    try {
      deps.teardown(w.branch);
      deps.log(`torn down ${w.branch} (PR merged)`);
    } catch (err) {
      deps.log(`teardown failed for ${w.branch}: ${err}`);
    }
  }
}
