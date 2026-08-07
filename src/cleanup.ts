import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MergedPR } from "./gh.ts";

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
  // action status (e.g. "fixing CI") still transitions to merged.
  reconcileMerged?: (mergedBranches: Set<string>) => void;
  // Live tmux session names, for the pr-<n>-fix session scan below.
  listSessions: () => string[];
  // Kill a tmux session by exact name (a merged PR's fix session).
  killSession: (session: string) => void;
  // Read a worktree's .yimbot-parent-session marker (its parent tmux session),
  // or null if it has none. Marks a worktree as a slice of a split group.
  readParentSession: (worktreePath: string) => string | null;
  // Whether this worktree's tmux session still hosts live "PR (i/n)" split slice
  // windows — a marker-independent signal that a split is in progress. Guards the
  // closed-unmerged reaper so a heartbeat landing before the slice markers are
  // written (or during a transient marker-read failure) can't tear down the split
  // parent and kill its slice windows.
  hasActiveSplitWindows: (worktree: Worktree) => boolean;
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

// A "PR (i/n)" window is what split-pr.sh names each slice window (pr_window_name),
// so a session with one is actively hosting a split. Marker-independent, hence a
// safety net the closed-unmerged reaper leans on when the markers aren't visible.
const SPLIT_SLICE_WINDOW_RE = /^PR \(\d+\/\d+\)$/;
export function isSplitSliceWindow(windowName: string): boolean {
  return SPLIT_SLICE_WINDOW_RE.test(windowName.trim());
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
// alone rather than reaped out from under in-progress work. The integration branch
// has no PR, so it is never part of the check. Whether a closed slice's (or the
// integration worktree's) work is safe to destroy is a separate gate the teardown
// applies via hasNoUnpushedWork.
export function groupReady(
  group: SplitGroup,
  mergedBranches: Set<string>,
  closedBranches: Set<string> = new Set(),
): boolean {
  return (
    group.sliceBranches.length > 0 &&
    group.sliceBranches.some((b) => mergedBranches.has(b)) &&
    group.sliceBranches.every((b) => mergedBranches.has(b) || closedBranches.has(b))
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

// A worktree enriched with the facts the orphan sweep needs to judge it.
// `hasSession` is whether a live tmux session belongs to its ticket; `inert` is
// clean working tree AND no commits ahead of base (nothing to lose); `ageMs` is
// how long since the worktree dir was created.
export type OrphanFacts = {
  worktree: Worktree;
  hasSession: boolean;
  // A launch is in progress: new-session.sh has created the worktree but not yet
  // its session (its .yimbot-launching marker is present). Session-less by nature,
  // so it needs its own guard to avoid being reaped mid-setup.
  launching: boolean;
  inert: boolean;
  ageMs: number;
};

// Worktrees safe to reap so the deploy step relaunches a fresh session: a
// session-less, inert worktree older than one heartbeat (past the launch race),
// with no launch in progress, that is not part of a split group. Any guard
// failing spares it.
export function selectOrphanWorktrees(
  facts: OrphanFacts[],
  opts: { grouped: Set<string>; minAgeMs: number },
): Worktree[] {
  return facts
    .filter(
      (f) =>
        !f.hasSession &&
        !f.launching &&
        f.inert &&
        f.ageMs >= opts.minAgeMs &&
        !opts.grouped.has(f.worktree.path),
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
  // A worktree's .yimbot-parent-session marker, to exclude split-group members.
  readParentSession: (worktreePath: string) => string | null;
  // Whether a live session belongs to the ticket owning this worktree dir name.
  // Prefix-matched (not exact) so the 50-char worktree/full session-name split
  // new-session.sh makes for long tickets can't produce a false "session-less".
  hasSessionFor: (worktreeName: string, sessions: string[]) => boolean;
  // Whether new-session.sh is still launching this worktree (its .yimbot-launching
  // marker is present) — spared so a slow setup hook is never reaped mid-launch.
  isLaunching: (worktreePath: string) => boolean;
  // Whether a worktree is inert: clean working tree AND no commits ahead of base.
  isInert: (worktreePath: string) => boolean;
  // Age of the worktree dir (now - mtime), to clear the launch race.
  ageMs: (worktreePath: string) => number;
  minAgeMs: number;
  // Tear down a worktree by its branch (== its ticket session name). Via end-session.sh.
  teardown: (branch: string) => void;
  log: (msg: string) => void;
};

// One sweep-step tick, run first in the heartbeat (before deploy). Reaps inert,
// session-less orphan worktrees so the deploy step relaunches a fresh session
// instead of adopting the leftover forever. The git/mtime checks run only on
// session-less, non-grouped, in-dir worktrees, so an active worktree costs no IO.
export async function sweepOrphanWorktrees(deps: OrphanSweepDeps): Promise<void> {
  let worktrees: Worktree[];
  try {
    worktrees = deps.listWorktrees();
  } catch (err) {
    deps.log(`orphan sweep: worktree list failed: ${err}`);
    return;
  }

  let sessions: string[];
  try {
    sessions = deps.listSessions();
  } catch (err) {
    deps.log(`orphan sweep: session list failed: ${err}`);
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
      // Skip the git/mtime IO for anything a cheap guard already excludes.
      const skip = hasSession || launching || grouped.has(w.path);
      return {
        worktree: w,
        hasSession,
        launching,
        inert: skip ? false : deps.isInert(w.path),
        ageMs: skip ? 0 : deps.ageMs(w.path),
      };
    });

  for (const w of selectOrphanWorktrees(facts, { grouped, minAgeMs: deps.minAgeMs })) {
    try {
      deps.teardown(w.branch);
      deps.log(`orphan sweep: torn down ${w.branch} (session-less, no unsaved work)`);
    } catch (err) {
      deps.log(`orphan sweep: teardown failed for ${w.branch}: ${err}`);
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

  deps.reconcileMerged?.(mergedBranches);

  // Closed-but-not-merged PRs (spikes, abandoned/superseded work). Fetched up front
  // because both the split-group readiness below and path (a2) need it. A failure to
  // list is non-fatal: closedBranches stays empty, so the group path falls back to
  // merged-only readiness and path (a2) reaps nothing this tick.
  let closed: MergedPR[] = [];
  try {
    closed = await deps.listClosedUnmergedPRs();
  } catch (err) {
    deps.log(`closed PR list failed: ${err}`);
  }
  const closedBranches = new Set(closed.map((p) => p.headRefName));

  // Split groups: slices marked with a parent session are torn down only as a
  // whole, once at least one slice merged and no slice PR is still open (see
  // groupReady). Both the integration worktree and its slices are excluded from the
  // per-branch paths below so a single slice resolving never tears the group down early.
  const groups = buildSplitGroups(worktrees, deps.readParentSession, deps.worktreesDir);
  const groupedPaths = new Set(groups.flatMap((g) => g.worktreePaths));

  for (const g of groups) {
    if (!groupReady(g, mergedBranches, closedBranches)) continue; // not resolved yet → wait
    // Gate only the members not backed by a merged PR — the integration worktree
    // and any closed slice — on having no unpushed work, so an abandoned slice
    // never destroys local-only work. Merged members are always safe to reap and
    // are never gated (their origin branch may already be deleted, which would
    // fail the check and wedge the group).
    const guarded = [
      ...g.slices.filter((s) => !mergedBranches.has(s.branch)),
      ...(g.integration ? [g.integration] : []),
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
    // through groupedPaths. Two marker-independent guards spare it: the durable
    // split-parent marker (written before the PR is closed, so it covers even the
    // pre-first-slice window) and live "PR (i/n)" slice windows.
    if (deps.isSplitParent(w.path)) {
      deps.log(`kept ${w.branch} (PR closed unmerged but worktree is a split parent)`);
      continue;
    }
    if (deps.hasActiveSplitWindows(w)) {
      deps.log(`kept ${w.branch} (PR closed unmerged but session has an active split in progress)`);
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
