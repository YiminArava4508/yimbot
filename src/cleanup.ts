import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MergedPR, OpenPR } from "./gh.ts";
import { isContinuationBranch, issueFromBranch } from "./pr-advance.ts";

export type Worktree = { path: string; branch: string };

export type SplitGroup = {
  session: string;
  integrationBranch: string | null;
  integration: Worktree | null;
  sliceBranches: string[];
  slices: Worktree[];
  worktreePaths: string[];
};

export type CleanupDeps = {
  // Live git worktrees (any location; filtered here to the worktrees dir).
  listWorktrees: () => Worktree[];
  // The viewer's merged PRs (number + head branch), gh-backed hence async.
  listMergedPRs: () => Promise<MergedPR[]>;
  // The viewer's closed-but-not-merged PRs (spikes, abandoned work). Their
  // worktree keeps a live session, so the orphan sweep spares it, and its PR
  // never merges, so the merged path ignores it; this reaps it when nothing
  // would be lost.
  listClosedUnmergedPRs: () => Promise<MergedPR[]>;
  // The viewer's open PRs. A worktree with NO PR anywhere (open, merged, or
  // closed) is a spike's: its ticket's Linear state is the only completion
  // signal, so the no-PR reap below keys off issueStateType instead of gh.
  listOpenPRs: () => Promise<OpenPR[]>;
  // The Linear workflow state type ("completed", "canceled", "started", ...) of
  // an issue by identifier (ENG-<n>). A terminal type on a no-PR worktree's
  // ticket means the human closed it out, so the worktree/session can go. Also
  // gates split-group teardown: a resolved PR set alone can't prove the split is
  // done (the next slice's PR may not exist yet), so the group holds until the
  // parent ticket goes terminal.
  issueStateType: (identifier: string) => Promise<string | null>;
  // Whether a closed PR's worktree holds no work teardown would destroy: a clean
  // tree AND every commit pushed to its own origin branch (the branch survives on
  // origin, recoverable). Gates the closed-unmerged teardown. Not the base-ref
  // "inert" check: a closed PR's commits never reach main, so comparing against
  // base would spare every spike that produced a commit.
  hasNoUnpushedWork: (worktreePath: string) => boolean;
  // Only worktrees under this directory are torn down, so the main checkout is
  // never touched even if a branch name somehow collides.
  worktreesDir: string;
  // Tear down a worktree by its branch (== its ticket session name): docker down,
  // worktree remove, branch delete, kill the branch-named session. Via end-session.sh.
  teardown: (branch: string) => void;
  // Reconcile the board against the full merged-branch set each tick. Called even
  // when a merged PR has no worktree left to tear down, so a row stuck on a stale
  // action status (e.g. "fixing CI") still transitions to merged. The open set
  // rides along so a merged split slice never marks its ticket's row merged while
  // sibling slice PRs are still open; skipped when the open list can't be fetched.
  reconcileMerged?: (mergedBranches: Set<string>, openBranches: Set<string>) => void;
  // Live tmux session names, for the pr-<n>-fix session scan below.
  listSessions: () => string[];
  // Kill a tmux session by exact name (a merged PR's fix session).
  killSession: (session: string) => void;
  // Read a worktree's .yimbot-parent-session marker (its parent tmux session),
  // or null if it has none. Marks a worktree as a slice of a split group.
  readParentSession: (worktreePath: string) => string | null;
  // Whether this worktree is flagged as a split integration parent (its
  // .yimbot-split-parent marker is present). Written before the ticket's PR is
  // closed to start a split, so it spares the parent through the whole split even
  // in the pre-first-slice window where no slice worktree/window exists yet.
  isSplitParent: (worktreePath: string) => boolean;
  log: (msg: string) => void;
};

// The tmux session / worktree dir a branch (or session name) maps to, mirroring
// new-session.sh's rule exactly (`sed 's/[^a-zA-Z0-9-]/-/g' | cut -c1-50`). The
// tmux session keeps the full name while the worktree dir is this sanitized form,
// so for a long or special-char name the two differ.
export function sanitizeBranchToSession(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 50);
}

// Read a worktree's .yimbot-parent-session marker, written by split-pr.sh when
// it carves a slice worktree out of an integration branch. Returns null when
// the worktree has no marker (a normal, non-split ticket) or when the marker
// is empty or contains only whitespace.
export function readParentSession(worktreePath: string): string | null {
  const markerPath = join(worktreePath, ".yimbot-parent-session");
  if (!existsSync(markerPath)) return null;
  try {
    const raw = readFileSync(markerPath, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

// The marker a split drops on its integration worktree at the start of the flow,
// before the ticket's PR (if any) is closed. Its presence tells the closed-unmerged
// reaper "a split is in progress here" even before the first slice exists.
export const SPLIT_PARENT_MARKER = ".yimbot-split-parent";

// Whether a worktree carries the split-parent marker.
export function isSplitParentWorktree(worktreePath: string): boolean {
  return existsSync(join(worktreePath, SPLIT_PARENT_MARKER));
}

// Assemble split groups from live worktrees. A worktree with a non-null parent
// (its .yimbot-parent-session marker) is a slice; its parent session names the
// group. The integration worktree is the one whose dir is <worktreesDir>/<session>
// (the ticket branch, no marker). Only groups with at least one slice are returned.
export function buildSplitGroups(
  worktrees: Worktree[],
  parentOf: (path: string) => string | null,
  worktreesDir: string,
): SplitGroup[] {
  const prefix = worktreesDir.endsWith("/") ? worktreesDir : `${worktreesDir}/`;
  const bySession = new Map<string, { slices: Worktree[] }>();
  for (const w of worktrees) {
    if (!w.path.startsWith(prefix)) continue;
    const parent = parentOf(w.path);
    if (parent === null) continue;
    const entry = bySession.get(parent) ?? { slices: [] };
    entry.slices.push(w);
    bySession.set(parent, entry);
  }
  const groups: SplitGroup[] = [];
  for (const [session, { slices }] of bySession) {
    // The marker holds the full tmux session name; the integration worktree dir is
    // its sanitized/50-char form (new-session.sh's rule), so match on the sanitized
    // name, not the raw one — otherwise a long/special session name never resolves
    // its integration worktree and it drops out of every split-group protection.
    const integrationDir = sanitizeBranchToSession(session);
    const integration = worktrees.find((w) => w.path === `${prefix}${integrationDir}`) ?? null;
    const worktreePaths = slices.map((s) => s.path);
    if (integration) worktreePaths.push(integration.path);
    groups.push({
      session,
      integrationBranch: integration ? integration.branch : null,
      integration,
      sliceBranches: slices.map((s) => s.branch),
      slices,
      worktreePaths,
    });
  }
  return groups;
}

// A group is ready to tear down once at least one slice merged AND no slice PR is
// still open (every remaining slice was closed unmerged — folded into a sibling or
// abandoned). Waiting for *every* slice to merge would wedge the whole group
// forever on one never-merging slice; but a group where nothing has merged is
// either mid-split (slices still being carved) or fully abandoned, so it is left
// alone rather than reaped out from under in-progress work. A skill-conformant
// integration branch has no PR of its own, but a slice PR opened from the
// integration branch directly carries no slice marker, so an open PR on the
// integration branch also holds the group. Whether a closed slice's (or the
// integration worktree's) work is safe to destroy is a separate gate the teardown
// applies via hasNoUnpushedWork.
export function groupReady(
  group: SplitGroup,
  mergedBranches: Set<string>,
  closedBranches: Set<string> = new Set(),
  openBranches: Set<string> = new Set(),
): boolean {
  return (
    group.sliceBranches.length > 0 &&
    group.sliceBranches.some((b) => mergedBranches.has(b)) &&
    group.sliceBranches.every((b) => mergedBranches.has(b) || closedBranches.has(b)) &&
    (group.integrationBranch === null || !openBranches.has(group.integrationBranch))
  );
}

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

// A worktree enriched with the facts the reattach step needs to judge it.
// `hasSession` is whether a live tmux session belongs to its ticket; `ageMs` is
// how long since the worktree dir was created (to clear the launch race).
export type OrphanFacts = {
  worktree: Worktree;
  hasSession: boolean;
  // A launch is in progress: new-session.sh has created the worktree but not yet
  // its session (its .yimbot-launching marker is present). Session-less by nature,
  // so it needs its own guard to avoid being reattached mid-setup.
  launching: boolean;
  ageMs: number;
};

// Worktrees to re-couple with a session: a session-less worktree older than one
// heartbeat (past the launch race), with no launch in progress, that is not part
// of a split group and whose PR has not resolved (merged/closed — those are the
// cleanup step's to tear down, and reattaching one would race that teardown).
// No inert gate: reattaching never destroys work, and the tmux session persists
// even if the resume finds no prior conversation, so an empty worktree is
// re-coupled once, not looped over. Any guard failing spares it.
export function selectOrphanWorktrees(
  facts: OrphanFacts[],
  opts: { grouped: Set<string>; resolved: Set<string>; minAgeMs: number },
): Worktree[] {
  return facts
    .filter(
      (f) =>
        !f.hasSession &&
        !f.launching &&
        f.ageMs >= opts.minAgeMs &&
        !opts.grouped.has(f.worktree.path) &&
        !opts.resolved.has(f.worktree.branch),
    )
    .map((f) => f.worktree);
}

export type OrphanSweepDeps = {
  // Live git worktrees (filtered here to the worktrees dir).
  listWorktrees: () => Worktree[];
  // Live tmux session names.
  listSessions: () => string[];
  // Only worktrees under this dir are considered, never the main checkout.
  worktreesDir: string;
  // Branches of the viewer's resolved (merged + closed) PRs. A resolved worktree
  // belongs to the cleanup step; excluding it here keeps reattach from racing the
  // teardown. Empty on a fetch failure, so a transient gh error only defers a
  // re-couple, never resurrects a resolved worktree.
  resolvedBranches: () => Promise<Set<string>>;
  // A worktree's .yimbot-parent-session marker, to exclude split-group members.
  readParentSession: (worktreePath: string) => string | null;
  // Whether a live session belongs to the ticket owning this worktree dir name.
  // Prefix-matched (not exact) so the 50-char worktree/full session-name split
  // new-session.sh makes for long tickets can't produce a false "session-less".
  hasSessionFor: (worktreeName: string, sessions: string[]) => boolean;
  // Whether new-session.sh is still launching this worktree (its .yimbot-launching
  // marker is present) — spared so a slow setup hook is never reattached mid-launch.
  isLaunching: (worktreePath: string) => boolean;
  // Age of the worktree dir (now - mtime), to clear the launch race.
  ageMs: (worktreePath: string) => number;
  minAgeMs: number;
  // Re-couple a worktree to a session by its branch, resuming the prior
  // conversation. Via new-session.sh with SESSION_RESUME.
  reattach: (branch: string) => void;
  log: (msg: string) => void;
};

// One reattach-step tick. Re-couples each session-less, unresolved worktree to a
// fresh session on the existing worktree instead of reaping it, so a session that
// died (crash, manual kill, reboot) while its PR is still open comes back with its
// work intact. The mtime check runs only on session-less, non-grouped, in-dir
// worktrees, so an active worktree costs no IO.
export async function sweepOrphanWorktrees(deps: OrphanSweepDeps): Promise<void> {
  let worktrees: Worktree[];
  try {
    worktrees = deps.listWorktrees();
  } catch (err) {
    deps.log(`reattach: worktree list failed: ${err}`);
    return;
  }

  let sessions: string[];
  try {
    sessions = deps.listSessions();
  } catch (err) {
    deps.log(`reattach: session list failed: ${err}`);
    return;
  }

  let resolved: Set<string>;
  try {
    resolved = await deps.resolvedBranches();
  } catch (err) {
    // A fetch failure must not resurrect a resolved worktree; defer this tick.
    deps.log(`reattach: resolved PR list failed: ${err}`);
    return;
  }

  const prefix = deps.worktreesDir.endsWith("/") ? deps.worktreesDir : `${deps.worktreesDir}/`;
  const grouped = new Set(
    buildSplitGroups(worktrees, deps.readParentSession, deps.worktreesDir).flatMap(
      (g) => g.worktreePaths,
    ),
  );

  const facts: OrphanFacts[] = worktrees
    .filter((w) => w.path.startsWith(prefix))
    .map((w) => {
      const name = w.path.slice(prefix.length);
      const hasSession = deps.hasSessionFor(name, sessions);
      const launching = hasSession ? false : deps.isLaunching(w.path);
      // Skip the mtime IO for anything a cheap guard already excludes.
      const skip = hasSession || launching || grouped.has(w.path);
      return { worktree: w, hasSession, launching, ageMs: skip ? 0 : deps.ageMs(w.path) };
    });

  for (const w of selectOrphanWorktrees(facts, { grouped, resolved, minAgeMs: deps.minAgeMs })) {
    try {
      deps.reattach(w.branch);
      deps.log(`reattach: re-coupled ${w.branch} (session-less, PR still open)`);
    } catch (err) {
      deps.log(`reattach: relaunch failed for ${w.branch}: ${err}`);
    }
  }
}

const FIX_SESSION_RE = /^pr-(\d+)-(?:fix|ci)$/;

// Live "pr-<n>-fix" / "pr-<n>-ci" sessions whose PR number is in the merged set.
// A fix session is named by PR number (not branch), so the branch-keyed worktree
// teardown never targets it; and it can outlive its worktree (the worktree may
// already be gone). So it is reconciled directly against the merged-PR numbers.
export function selectMergedFixSessions(sessions: string[], mergedPrNumbers: Set<number>): string[] {
  return sessions.filter((s) => {
    const m = FIX_SESSION_RE.exec(s);
    return m !== null && mergedPrNumbers.has(Number(m[1]));
  });
}

// One cleanup-step tick, run every heartbeat. Independent reconciliations against
// the viewer's PRs: (a) tear down each merged worktree (removes the worktree + its
// branch-named ticket session); (a2) tear down each closed-unmerged worktree that
// is inert (a spike's session-backed worktree the merged path and orphan sweep both
// miss); and (b) kill each live pr-<n>-fix / pr-<n>-ci session whose PR merged. All
// are self-deduping (a removed worktree / killed session is simply gone next tick),
// so there is no seen-set. Every external call is wrapped so a failure logs and
// continues, never crashing the heartbeat.
export async function cleanupOnce(deps: CleanupDeps): Promise<void> {
  let worktrees: Worktree[];
  try {
    worktrees = deps.listWorktrees();
  } catch (err) {
    deps.log(`worktree list failed: ${err}`);
    return;
  }

  let merged: MergedPR[];
  try {
    merged = await deps.listMergedPRs();
  } catch (err) {
    deps.log(`merged PR list failed: ${err}`);
    return;
  }

  const mergedBranches = new Set(merged.map((p) => p.headRefName));
  const mergedNumbers = new Set(merged.map((p) => p.number));

  // Fetched before the board reconcile: without the open set, a merged split
  // slice would mark its whole ticket row merged while sibling PRs are open.
  // Also feeds path (a3) below. On failure both sit the tick out.
  let openBranches: Set<string> | null = null;
  try {
    openBranches = new Set((await deps.listOpenPRs()).map((p) => p.headRefName));
  } catch (err) {
    deps.log(`open PR list failed: ${err}`);
  }

  if (openBranches !== null) deps.reconcileMerged?.(mergedBranches, openBranches);

  // Closed-but-not-merged PRs (spikes, abandoned/superseded work). Fetched up front
  // because both the split-group readiness below and path (a2) need it. A failure to
  // list is non-fatal: closedBranches stays empty, so the group path falls back to
  // merged-only readiness and path (a2) reaps nothing this tick.
  let closed: MergedPR[] = [];
  let closedListFailed = false;
  try {
    closed = await deps.listClosedUnmergedPRs();
  } catch (err) {
    closedListFailed = true;
    deps.log(`closed PR list failed: ${err}`);
  }
  const closedBranches = new Set(closed.map((p) => p.headRefName));

  // Split groups: slices marked with a parent session are torn down only as a
  // whole, once every slice PR resolved with at least one merged, the integration
  // branch has no open PR (see groupReady), and the parent ticket is Done/Canceled.
  // Both the integration worktree and its slices are excluded from the per-branch
  // paths below so a single slice resolving never tears the group down early.
  const groups = buildSplitGroups(worktrees, deps.readParentSession, deps.worktreesDir);
  const groupedPaths = new Set(groups.flatMap((g) => g.worktreePaths));

  // Without the open set, a slice PR opened from the integration branch is
  // invisible, so falling back to slices-only readiness could reap a live group;
  // the group loop sits the tick out instead (teardown self-dedupes, so a gh
  // failure only delays it a heartbeat).
  if (openBranches === null) {
    if (groups.length > 0) deps.log(`split-group teardown deferred (open PR list unavailable)`);
  } else {
    for (const g of groups) {
      if (!groupReady(g, mergedBranches, closedBranches, openBranches)) continue; // not resolved yet → wait
      // Slices are carved sequentially, so a resolved PR set does not mean the work
      // is done: the next slice's PR may simply not exist yet. The parent ticket's
      // Linear state is the authority on "all work done" — hold the group until the
      // ticket goes terminal. Sessions with no Linear identifier (Shortcut splits)
      // can't be looked up, so readiness alone decides for them, as before.
      const identifier = issueFromBranch(g.session);
      if (identifier !== null) {
        let stateType: string | null;
        try {
          stateType = await deps.issueStateType(identifier);
        } catch (err) {
          deps.log(`issue state lookup failed for ${identifier}: ${err}`);
          continue;
        }
        if (stateType !== "completed" && stateType !== "canceled") {
          deps.log(`kept split group ${g.session} (ticket ${identifier} not done: ${stateType})`);
          continue;
        }
      }
      // Gate only the members not backed by a merged PR — the integration worktree
      // and any closed slice — on having no unpushed work, so an abandoned slice
      // never destroys local-only work. Merged members are always safe to reap and
      // are never gated (their origin branch may already be deleted, which would
      // fail the check and wedge the group). The integration branch counts as merged
      // when a slice PR was opened from it and landed.
      const guarded = [
        ...g.slices.filter((s) => !mergedBranches.has(s.branch)),
        ...(g.integration && !mergedBranches.has(g.integration.branch) ? [g.integration] : []),
      ];
      if (!guarded.every((w) => deps.hasNoUnpushedWork(w.path))) {
        deps.log(`kept split group ${g.session} (a closed slice or integration worktree has unsaved work)`);
        continue;
      }
      try {
        if (g.integrationBranch) deps.teardown(g.integrationBranch);
        else deps.killSession(g.session);
        for (const slice of g.sliceBranches) deps.teardown(slice);
        deps.log(`torn down split group ${g.session} (${g.sliceBranches.length} slice PRs resolved)`);
      } catch (err) {
        deps.log(`split-group teardown failed for ${g.session}: ${err}`);
      }
    }
  }

  // (a) normal merged worktrees (excluding any that belong to a split group) →
  // tear down worktree + branch-named ticket session.
  for (const w of selectMergedWorktrees(worktrees, mergedBranches, deps.worktreesDir)) {
    if (groupedPaths.has(w.path)) continue;
    try {
      deps.teardown(w.branch);
      deps.log(`torn down ${w.branch} (PR merged)`);
    } catch (err) {
      deps.log(`teardown failed for ${w.branch}: ${err}`);
    }
  }

  // (a2) closed-but-not-merged PRs (spikes, abandoned/superseded work): tear down
  // worktree + branch-named session, but only when no unpushed work would be lost
  // (clean tree, everything on origin). A live session does NOT spare it (unlike
  // the orphan sweep) — the teardown kills it. The closed-PR set was fetched above.
  for (const w of selectMergedWorktrees(worktrees, closedBranches, deps.worktreesDir)) {
    if (groupedPaths.has(w.path)) continue;
    // A split parent whose original PR was just closed but whose slice markers
    // aren't visible yet (race, or a transient marker-read failure) would fall
    // through groupedPaths. The durable split-parent marker (written before the
    // PR is closed, so it covers even the pre-first-slice window) spares it.
    if (deps.isSplitParent(w.path)) {
      deps.log(`kept ${w.branch} (PR closed unmerged but worktree is a split parent)`);
      continue;
    }
    if (!deps.hasNoUnpushedWork(w.path)) {
      deps.log(`kept ${w.branch} (PR closed unmerged but worktree has unsaved work)`);
      continue;
    }
    try {
      deps.teardown(w.branch);
      deps.log(`torn down ${w.branch} (PR closed unmerged, no unsaved work)`);
    } catch (err) {
      deps.log(`teardown failed for ${w.branch}: ${err}`);
    }
  }

  // (a3) worktrees with NO PR anywhere (a true spike never opens one): the ticket's
  // Linear state is the only completion signal, so reap once it goes terminal
  // (Done/Canceled — the human closing it out is the gate, mirroring a PR merge).
  // Needs the full PR picture to know "no PR": if the open list failed above, or
  // the closed list failed (a closed-PR worktree would masquerade as no-PR),
  // this path sits the tick out.
  if (openBranches !== null && !closedListFailed) {
    const prefix = deps.worktreesDir.endsWith("/") ? deps.worktreesDir : `${deps.worktreesDir}/`;
    for (const w of worktrees) {
      if (!w.path.startsWith(prefix)) continue;
      if (mergedBranches.has(w.branch) || closedBranches.has(w.branch) || openBranches.has(w.branch)) continue;
      if (groupedPaths.has(w.path)) continue;
      // An AC continuation shares its issue with an already-merged PR, and that
      // issue may be Done while the continuation is still working: never its reap
      // trigger. Its own PR (once opened and merged/closed) tears it down instead.
      if (isContinuationBranch(w.branch)) continue;
      const identifier = issueFromBranch(w.branch);
      if (identifier === null) continue;
      let stateType: string | null;
      try {
        stateType = await deps.issueStateType(identifier);
      } catch (err) {
        deps.log(`issue state lookup failed for ${identifier}: ${err}`);
        continue;
      }
      if (stateType !== "completed" && stateType !== "canceled") continue;
      // Same guards as the closed-unmerged path: a split in progress or unsaved
      // work spares the worktree.
      if (deps.isSplitParent(w.path)) {
        deps.log(`kept ${w.branch} (ticket ${identifier} ${stateType} but worktree is a split parent)`);
        continue;
      }
      if (!deps.hasNoUnpushedWork(w.path)) {
        deps.log(`kept ${w.branch} (ticket ${identifier} ${stateType} but worktree has unsaved work)`);
        continue;
      }
      try {
        deps.teardown(w.branch);
        deps.log(`torn down ${w.branch} (ticket ${identifier} ${stateType}, no PR)`);
      } catch (err) {
        deps.log(`teardown failed for ${w.branch}: ${err}`);
      }
    }
  }

  // (b) merged PRs' fix sessions → kill directly (branch teardown can't, and the
  // worktree may already be gone).
  let sessions: string[];
  try {
    sessions = deps.listSessions();
  } catch (err) {
    deps.log(`session list failed: ${err}`);
    return;
  }

  for (const s of selectMergedFixSessions(sessions, mergedNumbers)) {
    try {
      deps.killSession(s);
      deps.log(`killed ${s} (PR merged)`);
    } catch (err) {
      deps.log(`kill failed for ${s}: ${err}`);
    }
  }
}
