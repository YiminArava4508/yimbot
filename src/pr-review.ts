import type { BlockedInfo, ChecksInfo, MergeableInfo, OpenPR, UnresolvedInfo } from "./gh.ts";

// The tmux session name for a PR's fix run. Keyed by PR number (not branch) so
// the in-flight guard is one-fix-session-per-PR regardless of the branch slug.
export function fixSessionName(prNumber: number): string {
  return `pr-${prNumber}-fix`;
}

// The tmux session name for a PR's CI-fix run (sibling of fixSessionName).
export function ciSessionName(prNumber: number): string {
  return `pr-${prNumber}-ci`;
}

// The tmux session name for a PR's merge-conflict-fix run (sibling of the two above).
export function conflictSessionName(prNumber: number): string {
  return `pr-${prNumber}-conflict`;
}

// The tmux session name for a PR's merge-queue-blocked fix (sibling of the others).
export function blockedSessionName(prNumber: number): string {
  return `pr-${prNumber}-blocked`;
}

// Every fix session/window name a PR can have — the set the in-flight guard
// checks so any one fix kind blocks the others on the shared worktree.
export function fixSessionNames(prNumber: number): string[] {
  return [fixSessionName(prNumber), ciSessionName(prNumber), conflictSessionName(prNumber), blockedSessionName(prNumber)];
}

// Per-process record of the newest other-authored unresolved comment timestamp
// (epoch ms) handled per PR. Re-triggering compares against this so a later round
// of comments re-spawns while threads deliberately left unresolved do not loop.
// `lastHandledCiSha` is the sibling for the CI-fix step: the failing head SHA
// handled per PR, so a still-red build re-triggers only when the head moves (a
// fix push) and a green build never does.
//
// `pendingSpawn` records a fixer we spawned but have not yet seen live via
// `inFlightFixKinds`. Spawns are detached, so a session/window is invisible for a
// tick or two after `spawnFix`/`spawnCiFix` returns (slow standalone setup hook).
// The tmux-visibility guard alone would then let the *other* fix kind (a
// different session name) spawn onto the PR's shared worktree in that window.
// The latch blocks the other kind until the first becomes visible (then it
// clears and `inFlightFixKinds` takes over), while still allowing a genuinely
// newer round of the same kind to re-trigger.
// In-memory: a restart clears it (at most one already-handled round re-runs).
export type FixKind = "fix" | "ci" | "conflict" | "blocked";

export const ALL_FIX_KINDS: FixKind[] = ["fix", "ci", "conflict", "blocked"];

// The session/window name for a PR's fix of a given kind.
export function sessionNameFor(kind: FixKind, prNumber: number): string {
  return kind === "fix"
    ? fixSessionName(prNumber)
    : kind === "ci"
      ? ciSessionName(prNumber)
      : kind === "conflict"
        ? conflictSessionName(prNumber)
        : blockedSessionName(prNumber);
}

export type ReviewState = {
  lastHandledAt: Map<number, number>;
  lastHandledCiSha: Map<number, string>;
  lastHandledConflictSha: Map<number, string>;
  lastHandledBlockedSha: Map<number, string>;
  pendingSpawn: Map<number, FixKind>;
  // "<prNumber>:<kind>" -> epoch ms the fix was first seen in flight. Drives the
  // stale reap backstop. In-memory: a restart resets the timers.
  fixSeenAt: Map<string, number>;
};

export function freshReviewState(): ReviewState {
  return {
    lastHandledAt: new Map(),
    lastHandledCiSha: new Map(),
    lastHandledConflictSha: new Map(),
    lastHandledBlockedSha: new Map(),
    pendingSpawn: new Map(),
    fixSeenAt: new Map(),
  };
}

export type PrReviewDeps = {
  // The viewer's open PRs (drafts included; filtered here).
  listOpenPRs: () => Promise<OpenPR[]>;
  // Unresolved-thread summary for a PR: count + newest other-authored comment ms.
  unresolvedInfo: (prNumber: number) => Promise<UnresolvedInfo>;
  // Mergeability summary for a PR: conflicting/mergeable/unknown + head SHA.
  mergeableInfo: (prNumber: number) => Promise<MergeableInfo>;
  // CI summary for a PR: rollup state + head SHA.
  checksInfo: (prNumber: number) => Promise<ChecksInfo>;
  // Blocked summary for a PR: carries the merge-queue "blocked" label + head SHA.
  blockedInfo: (prNumber: number) => Promise<BlockedInfo>;
  // Which fix kinds are currently in flight for a PR (comment/ci/conflict).
  // Empty means no fixer is on the shared worktree. Replaces the old boolean
  // guard so the reaper can act per kind.
  inFlightFixKinds: (prNumber: number, branch: string) => FixKind[];
  // Tear down a PR's fix of a kind (tmux session/window only, never the worktree).
  reapFix: (prNumber: number, branch: string, kind: FixKind) => void;
  // Injected clock (epoch ms) for the stale-reap timer; Date.now in production.
  now: () => number;
  // Stale-reap threshold: reap a fix in flight longer than this regardless of state.
  reapStaleMs: number;
  // Launch a comment-fix session (session name, branch to check out, PR number).
  spawnFix: (sessionName: string, branch: string, prNumber: number) => void;
  // Launch a CI-fix session (session name, branch to check out, PR number).
  spawnCiFix: (sessionName: string, branch: string, prNumber: number) => void;
  // Launch a merge-conflict-fix session (session name, branch to check out, PR number).
  spawnConflictFix: (sessionName: string, branch: string, prNumber: number) => void;
  // Launch a merge-queue-blocked fix session (session name, branch to check out, PR number).
  spawnBlockedFix: (sessionName: string, branch: string, prNumber: number) => void;
  log: (msg: string) => void;
};

// Whether a fix's remit is definitively complete, per PR state. Strict on
// purpose: conflict waits out GitHub's post-push UNKNOWN window (only MERGEABLE
// counts), CI waits out a re-running suite (only passing counts), and a comment
// fix has no crisp signal so it relies on the stale backstop. A gh read error is
// "not met" (never reap on a failed read); the caller logs it.
async function reapObjectiveMet(kind: FixKind, prNumber: number, deps: PrReviewDeps): Promise<boolean> {
  if (kind === "conflict") return (await deps.mergeableInfo(prNumber)).state === "mergeable";
  if (kind === "ci") return (await deps.checksInfo(prNumber)).state === "passing";
  return false;
}

// One review-step tick, run every heartbeat. For each non-draft open PR, skip if
// any fix (comment, conflict, blocked, or CI) is actively running, then handle in
// priority order: comments, then conflict, then blocked, then CI. All four fixes
// share the PR's worktree, so at most one is spawned per PR per tick; the others
// are picked up a later tick once the running one has ended.
//
// Comments first — skip if nothing is unresolved, if only the viewer's own
// replies remain, or if the newest other-authored comment is not newer than the
// last one handled (so deliberately-left threads never loop); otherwise spawn a
// comment fix, record the timestamp, and move on.
//
// Conflict second — only when there is no comment work. Skip unless the PR is
// conflicting with the base (mergeable/unknown do nothing); skip if we already
// handled this head SHA (so a clean bail that pushes nothing never loops, and a
// resolution re-triggers only when the head moves); otherwise spawn a conflict
// fix and record the SHA.
//
// Blocked third, only when there is no comment or conflict work. Skip unless
// the merge queue has the PR's blocked label set; skip if we already handled this
// head SHA; otherwise spawn a blocked fix and record the SHA.
//
// CI last, only when there is no comment, conflict, or blocked work. Skip unless
// CI has concluded as failing (passing/pending/none do nothing); skip if we
// already handled this failing head SHA (so a red build re-triggers only when a
// fix push moves the head); otherwise spawn a CI fix and record the SHA.
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
    const running = deps.inFlightFixKinds(pr.number, pr.headRefName);
    // Prune timers for kinds no longer in flight so a future fix of that kind
    // starts a fresh stale clock (runs even when nothing is in flight now).
    for (const kind of ALL_FIX_KINDS) {
      if (!running.includes(kind)) state.fixSeenAt.delete(`${pr.number}:${kind}`);
    }
    if (running.length > 0) {
      const now = deps.now();
      for (const kind of running) {
        // A blocked fix owns its whole lifecycle: the fix-pr-blocked skill fixes the
        // Aviator combined-CI failure, swaps blocked -> ready-to-merge, then closes its
        // own session. The daemon must never reap it, or it races that work -- the label
        // clears mid-investigation (another PR in the batch was the culprit) or right
        // after the skill's own relabel, before it finishes cleaning up. It still counts
        // as in flight, so it keeps the other fix kinds off the shared worktree below.
        if (kind === "blocked") continue;
        const key = `${pr.number}:${kind}`;
        if (!state.fixSeenAt.has(key)) state.fixSeenAt.set(key, now);
        const stale = now - (state.fixSeenAt.get(key) as number) >= deps.reapStaleMs;
        let done = false;
        if (!stale) {
          try {
            done = await reapObjectiveMet(kind, pr.number, deps);
          } catch (err) {
            deps.log(`reap check failed for PR #${pr.number} (${kind}): ${err}`);
          }
        }
        if (stale || done) {
          deps.reapFix(pr.number, pr.headRefName, kind);
          state.fixSeenAt.delete(key);
          deps.log(`reaped ${sessionNameFor(kind, pr.number)} for PR #${pr.number} (${stale ? "stale" : "objective met"})`);
        }
      }
      state.pendingSpawn.delete(pr.number); // a fixer is (or was) running; do not spawn this tick
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
      if (pending && pending !== "fix") continue; // another fix kind is starting on the shared worktree; wait
      const name = fixSessionName(pr.number);
      try {
        deps.spawnFix(name, pr.headRefName, pr.number);
        state.lastHandledAt.set(pr.number, info.newestOtherCommentAt as number);
        state.pendingSpawn.set(pr.number, "fix");
        deps.log(`spawned ${name} for PR #${pr.number} (${info.count} unresolved, new comment)`);
      } catch (err) {
        deps.log(`spawn failed for PR #${pr.number}: ${err}`);
      }
      continue; // one fix per PR per tick, all four fixes share the worktree
    }

    let mergeable: MergeableInfo;
    try {
      mergeable = await deps.mergeableInfo(pr.number);
    } catch (err) {
      deps.log(`mergeable info failed for PR #${pr.number}: ${err}`);
      continue;
    }
    if (mergeable.state === "conflicting") {
      // A conflicting PR never falls through to CI: a red build can't be fixed
      // while the branch won't merge, and a CI fix must not land on a conflicting
      // worktree. Spawn a conflict fix when it's a head we haven't handled and no
      // other fix kind is mid-spawn; otherwise just wait.
      const unhandled = state.lastHandledConflictSha.get(pr.number) !== mergeable.headSha;
      if (unhandled && !(pending && pending !== "conflict")) {
        const name = conflictSessionName(pr.number);
        try {
          deps.spawnConflictFix(name, pr.headRefName, pr.number);
          state.lastHandledConflictSha.set(pr.number, mergeable.headSha);
          state.pendingSpawn.set(pr.number, "conflict");
          deps.log(`spawned ${name} for PR #${pr.number} (conflicting @ ${mergeable.headSha})`);
        } catch (err) {
          deps.log(`conflict spawn failed for PR #${pr.number}: ${err}`);
        }
      }
      continue; // one fix per PR per tick, all four fixes share the worktree
    }

    let blocked: BlockedInfo;
    try {
      blocked = await deps.blockedInfo(pr.number);
    } catch (err) {
      deps.log(`blocked info failed for PR #${pr.number}: ${err}`);
      continue;
    }
    if (blocked.blocked) {
      // The merge queue kicked this PR out after its combined-CI batch failed.
      // Its own CI is usually green (the failure was in the combined draft PR),
      // so this never reaches the CI block. Spawn a blocked fix on an unhandled
      // head and when no other fix kind is mid-spawn; otherwise just wait. Dedup
      // by head SHA bounds it to one automated attempt per head, so a re-block at
      // the same SHA (another PR in the batch is the culprit) does not loop.
      const unhandled = state.lastHandledBlockedSha.get(pr.number) !== blocked.headSha;
      if (unhandled && !(pending && pending !== "blocked")) {
        const name = blockedSessionName(pr.number);
        try {
          deps.spawnBlockedFix(name, pr.headRefName, pr.number);
          state.lastHandledBlockedSha.set(pr.number, blocked.headSha);
          state.pendingSpawn.set(pr.number, "blocked");
          deps.log(`spawned ${name} for PR #${pr.number} (blocked @ ${blocked.headSha})`);
        } catch (err) {
          deps.log(`blocked spawn failed for PR #${pr.number}: ${err}`);
        }
      }
      continue; // one fix per PR per tick, all four fixes share the worktree
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
    if (pending && pending !== "ci") continue; // another fix kind is starting on the shared worktree; wait

    const ciName = ciSessionName(pr.number);
    try {
      deps.spawnCiFix(ciName, pr.headRefName, pr.number);
      state.lastHandledCiSha.set(pr.number, checks.headSha);
      state.pendingSpawn.set(pr.number, "ci");
      deps.log(`spawned ${ciName} for PR #${pr.number} (CI failing @ ${checks.headSha})`);
    } catch (err) {
      deps.log(`ci spawn failed for PR #${pr.number}: ${err}`);
    }
  }
}
