import type { OpenPR } from "./gh.ts";

// The tmux session name for a PR's fix run. Keyed by PR number (not branch) so
// the in-flight guard is one-fix-session-per-PR regardless of the branch slug.
export function fixSessionName(prNumber: number): string {
  return `pr-${prNumber}-fix`;
}

// Grace window after spawning a fix before that PR may be spawned again. It
// covers the gap between spawnFix returning and new-session.sh actually creating
// the tmux session/window (worktree add + fetch can take seconds), during which
// fixInFlight would still report false. Past the window a re-spawn is allowed, so
// a spawn that silently failed (no session ever appeared) is retried.
export const SPAWN_GRACE_MS = 5 * 60 * 1000;

// Per-process record of when each PR's fix was last spawned, to back the grace
// window above. Not persisted: a restart clears it, and fixInFlight (real tmux
// state) still prevents duplicates for any session that did come up.
export type ReviewState = { spawnedAt: Map<number, number> };

export function freshReviewState(): ReviewState {
  return { spawnedAt: new Map() };
}

export type PrReviewDeps = {
  // The viewer's open PRs (drafts included; filtered here).
  listOpenPRs: () => Promise<OpenPR[]>;
  // Unresolved review-thread count for a PR (any author).
  unresolvedCount: (prNumber: number) => Promise<number>;
  // In-flight guard: whether a fix for this PR is already running or
  // finished-but-open, either as a standalone pr-<n>-fix session or as a
  // pr-<n>-fix window inside the branch's ticket session.
  fixInFlight: (prNumber: number, branch: string) => boolean;
  // Launch a fix session (session name, branch to check out in the worktree).
  spawnFix: (sessionName: string, branch: string) => void;
  // Current time in ms (injectable for tests).
  now: () => number;
  log: (msg: string) => void;
};

// One review-step tick, run every heartbeat. For each non-draft open PR with
// unresolved comments and no fix already in flight, spawn a fix session. Dedup is
// three-layered: resolved threads (a fully addressed PR has zero unresolved
// threads next tick), the fixInFlight session/window guard, and a short spawn
// grace window that closes the race where a just-spawned session is not yet
// visible to fixInFlight. A finished fix run is left alive, so its continued
// existence keeps that PR from re-spawning until the user closes it.
export async function reviewOnce(state: ReviewState, deps: PrReviewDeps): Promise<void> {
  let prs: OpenPR[];
  try {
    prs = await deps.listOpenPRs();
  } catch (err) {
    deps.log(`pr list failed: ${err}`);
    return;
  }

  const now = deps.now();
  for (const pr of prs) {
    if (pr.isDraft) continue;
    const name = fixSessionName(pr.number);
    if (deps.fixInFlight(pr.number, pr.headRefName)) continue; // a fix is still running/open

    const spawnedAt = state.spawnedAt.get(pr.number);
    if (spawnedAt !== undefined && now - spawnedAt < SPAWN_GRACE_MS) continue; // just spawned; session not yet visible

    let count: number;
    try {
      count = await deps.unresolvedCount(pr.number);
    } catch (err) {
      deps.log(`thread count failed for PR #${pr.number}: ${err}`);
      continue;
    }
    if (count <= 0) continue;

    try {
      deps.spawnFix(name, pr.headRefName);
      state.spawnedAt.set(pr.number, now);
      deps.log(`spawned ${name} for PR #${pr.number} (${count} unresolved)`);
    } catch (err) {
      deps.log(`spawn failed for PR #${pr.number}: ${err}`);
    }
  }
}
