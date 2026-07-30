import type { ChecksInfo, OpenPR, UnresolvedInfo } from "./gh.ts";

// The tmux session name for a PR's fix run. Keyed by PR number (not branch) so
// the in-flight guard is one-fix-session-per-PR regardless of the branch slug.
export function fixSessionName(prNumber: number): string {
  return `pr-${prNumber}-fix`;
}

// The tmux session name for a PR's CI-fix run (sibling of fixSessionName).
export function ciSessionName(prNumber: number): string {
  return `pr-${prNumber}-ci`;
}

// Per-process record of the newest other-authored unresolved comment timestamp
// (epoch ms) handled per PR. Re-triggering compares against this so a later round
// of comments re-spawns while threads deliberately left unresolved do not loop.
// `lastHandledCiSha` is the sibling for the CI-fix step: the failing head SHA
// handled per PR, so a still-red build re-triggers only when the head moves (a
// fix push) and a green build never does.
//
// `pendingSpawn` records a fixer we spawned but have not yet seen live via
// `fixInFlight`. Spawns are detached, so a session/window is invisible for a tick
// or two after `spawnFix`/`spawnCiFix` returns (slow standalone setup hook). The
// tmux-visibility guard alone would then let the *other* fix kind (a different
// session name) spawn onto the PR's shared worktree in that window. The latch
// blocks the other kind until the first becomes visible (then it clears and
// `fixInFlight` takes over), while still allowing a genuinely newer round of the
// same kind to re-trigger.
// In-memory: a restart clears it (at most one already-handled round re-runs).
export type ReviewState = {
  lastHandledAt: Map<number, number>;
  lastHandledCiSha: Map<number, string>;
  pendingSpawn: Map<number, "fix" | "ci">;
};

export function freshReviewState(): ReviewState {
  return { lastHandledAt: new Map(), lastHandledCiSha: new Map(), pendingSpawn: new Map() };
}

export type PrReviewDeps = {
  // The viewer's open PRs (drafts included; filtered here).
  listOpenPRs: () => Promise<OpenPR[]>;
  // Unresolved-thread summary for a PR: count + newest other-authored comment ms.
  unresolvedInfo: (prNumber: number) => Promise<UnresolvedInfo>;
  // CI summary for a PR: rollup state + head SHA.
  checksInfo: (prNumber: number) => Promise<ChecksInfo>;
  // In-flight guard: a pr-<n>-fix OR pr-<n>-ci session/window exists = a fix is
  // actively running on this PR's (shared) worktree. Serializes both fix kinds
  // onto one worktree so they never edit/push the same branch concurrently.
  fixInFlight: (prNumber: number, branch: string) => boolean;
  // Launch a comment-fix session (session name, branch to check out).
  spawnFix: (sessionName: string, branch: string) => void;
  // Launch a CI-fix session (session name, branch to check out).
  spawnCiFix: (sessionName: string, branch: string) => void;
  log: (msg: string) => void;
};

// One review-step tick, run every heartbeat. For each non-draft open PR, skip if
// any fix (comment or CI) is actively running, then handle in priority order:
//
// Comments first — skip if nothing is unresolved, if only the viewer's own
// replies remain, or if the newest other-authored comment is not newer than the
// last one handled (so deliberately-left threads never loop); otherwise spawn a
// comment fix, record the timestamp, and move on. Because both fixes share the
// PR's worktree, we never also spawn a CI fix the same tick — it is picked up a
// later tick once the comment fix has ended.
//
// CI second — only when there is no comment work. Skip unless CI has concluded
// as failing (passing/pending/none do nothing); skip if we already handled this
// failing head SHA (so a red build re-triggers only when a fix push moves the
// head); otherwise spawn a CI fix and record the SHA.
export async function reviewOnce(state: ReviewState, deps: PrReviewDeps): Promise<void> {
  let prs: OpenPR[];
  try {
    prs = await deps.listOpenPRs();
  } catch (err) {
    deps.log(`pr list failed: ${err}`);
    return;
  }

  for (const pr of prs) {
    if (pr.isDraft) continue;
    if (deps.fixInFlight(pr.number, pr.headRefName)) {
      state.pendingSpawn.delete(pr.number); // a fixer is visibly running; fixInFlight is now the guard
      continue;
    }
    // A fixer we spawned but have not yet seen live: blocks the *other* kind
    // (which has a different session name the tmux guard can't dedupe) from
    // landing on the shared worktree until this one becomes visible.
    const pending = state.pendingSpawn.get(pr.number);

    let info: UnresolvedInfo;
    try {
      info = await deps.unresolvedInfo(pr.number);
    } catch (err) {
      deps.log(`thread info failed for PR #${pr.number}: ${err}`);
      continue;
    }

    const lastHandled = state.lastHandledAt.get(pr.number);
    const hasNewComment =
      info.count > 0 &&
      info.newestOtherCommentAt !== null &&
      (lastHandled === undefined || info.newestOtherCommentAt > lastHandled);
    if (hasNewComment) {
      if (pending === "ci") continue; // a CI fix is starting on the shared worktree; wait
      const name = fixSessionName(pr.number);
      try {
        deps.spawnFix(name, pr.headRefName);
        state.lastHandledAt.set(pr.number, info.newestOtherCommentAt as number);
        state.pendingSpawn.set(pr.number, "fix");
        deps.log(`spawned ${name} for PR #${pr.number} (${info.count} unresolved, new comment)`);
      } catch (err) {
        deps.log(`spawn failed for PR #${pr.number}: ${err}`);
      }
      continue; // one fix per PR per tick — both fixes share the worktree
    }

    let checks: ChecksInfo;
    try {
      checks = await deps.checksInfo(pr.number);
    } catch (err) {
      deps.log(`checks info failed for PR #${pr.number}: ${err}`);
      continue;
    }
    if (checks.state !== "failing") continue; // passing/pending/none — nothing to do
    if (state.lastHandledCiSha.get(pr.number) === checks.headSha) continue; // already handled this red head
    if (pending === "fix") continue; // a comment fix is starting on the shared worktree; wait

    const ciName = ciSessionName(pr.number);
    try {
      deps.spawnCiFix(ciName, pr.headRefName);
      state.lastHandledCiSha.set(pr.number, checks.headSha);
      state.pendingSpawn.set(pr.number, "ci");
      deps.log(`spawned ${ciName} for PR #${pr.number} (CI failing @ ${checks.headSha})`);
    } catch (err) {
      deps.log(`ci spawn failed for PR #${pr.number}: ${err}`);
    }
  }
}
