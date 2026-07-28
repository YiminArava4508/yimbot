import type { OpenPR, UnresolvedInfo } from "./gh.ts";

// The tmux session name for a PR's fix run. Keyed by PR number (not branch) so
// the in-flight guard is one-fix-session-per-PR regardless of the branch slug.
export function fixSessionName(prNumber: number): string {
  return `pr-${prNumber}-fix`;
}

// Per-process record of the newest other-authored unresolved comment timestamp
// (epoch ms) handled per PR. Re-triggering compares against this so a later round
// of comments re-spawns while threads deliberately left unresolved do not loop.
// In-memory: a restart clears it (at most one already-handled round re-runs).
export type ReviewState = { lastHandledAt: Map<number, number> };

export function freshReviewState(): ReviewState {
  return { lastHandledAt: new Map() };
}

export type PrReviewDeps = {
  // The viewer's open PRs (drafts included; filtered here).
  listOpenPRs: () => Promise<OpenPR[]>;
  // Unresolved-thread summary for a PR: count + newest other-authored comment ms.
  unresolvedInfo: (prNumber: number) => Promise<UnresolvedInfo>;
  // In-flight guard: a pr-<n>-fix session/window exists = a fix is actively
  // running (the fix session ends itself when done).
  fixInFlight: (prNumber: number, branch: string) => boolean;
  // Launch a fix session (session name, branch to check out in the worktree).
  spawnFix: (sessionName: string, branch: string) => void;
  log: (msg: string) => void;
};

// One review-step tick, run every heartbeat. For each non-draft open PR: skip if
// a fix is actively running; skip if nothing is unresolved; skip if only the
// viewer's own replies remain; skip if the newest other-authored comment is not
// newer than the last one handled (so deliberately-left threads never loop);
// otherwise spawn a fix and record the timestamp handled.
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
    const name = fixSessionName(pr.number);
    if (deps.fixInFlight(pr.number, pr.headRefName)) continue; // a fix is actively running

    let info: UnresolvedInfo;
    try {
      info = await deps.unresolvedInfo(pr.number);
    } catch (err) {
      deps.log(`thread info failed for PR #${pr.number}: ${err}`);
      continue;
    }
    if (info.count <= 0) continue; // nothing unresolved
    if (info.newestOtherCommentAt === null) continue; // only our own replies remain; awaiting a human

    const lastHandled = state.lastHandledAt.get(pr.number);
    if (lastHandled !== undefined && info.newestOtherCommentAt <= lastHandled) continue; // already handled

    try {
      deps.spawnFix(name, pr.headRefName);
      state.lastHandledAt.set(pr.number, info.newestOtherCommentAt);
      deps.log(`spawned ${name} for PR #${pr.number} (${info.count} unresolved, new comment)`);
    } catch (err) {
      deps.log(`spawn failed for PR #${pr.number}: ${err}`);
    }
  }
}
