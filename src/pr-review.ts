import type { OpenPR } from "./gh.ts";

// The tmux session name for a PR's fix run. Keyed by PR number (not branch) so
// the in-flight guard is one-fix-session-per-PR regardless of the branch slug.
export function fixSessionName(prNumber: number): string {
  return `pr-${prNumber}-fix`;
}

export type PrReviewDeps = {
  // The viewer's open PRs (drafts included; filtered here).
  listOpenPRs: () => OpenPR[];
  // Unresolved review-thread count for a PR (any author).
  unresolvedCount: (prNumber: number) => number;
  // In-flight guard: whether a fix for this PR is already running or
  // finished-but-open, either as a standalone pr-<n>-fix session or as a
  // pr-<n>-fix window inside the branch's ticket session.
  fixInFlight: (prNumber: number, branch: string) => boolean;
  // Launch a fix session (session name, branch to check out in the worktree).
  spawnFix: (sessionName: string, branch: string) => void;
  log: (msg: string) => void;
};

// One review-step tick, run every heartbeat. For each non-draft open PR with
// unresolved comments and no fix session already running, spawn a fix session.
// There is no seen-set: dedup comes from resolved threads (a fully addressed PR
// has zero unresolved threads next tick) plus the in-flight session guard. A
// finished fix run is left alive (a window in the ticket session, or a standalone
// session when that session is gone), so its continued existence keeps that PR
// from re-spawning until the user closes it.
export function reviewOnce(deps: PrReviewDeps): void {
  let prs: OpenPR[];
  try {
    prs = deps.listOpenPRs();
  } catch (err) {
    deps.log(`pr list failed: ${err}`);
    return;
  }

  for (const pr of prs) {
    if (pr.isDraft) continue;
    const name = fixSessionName(pr.number);
    if (deps.fixInFlight(pr.number, pr.headRefName)) continue; // a fix is still running/open

    let count: number;
    try {
      count = deps.unresolvedCount(pr.number);
    } catch (err) {
      deps.log(`thread count failed for PR #${pr.number}: ${err}`);
      continue;
    }
    if (count <= 0) continue;

    try {
      deps.spawnFix(name, pr.headRefName);
      deps.log(`spawned ${name} for PR #${pr.number} (${count} unresolved)`);
    } catch (err) {
      deps.log(`spawn failed for PR #${pr.number}: ${err}`);
    }
  }
}
