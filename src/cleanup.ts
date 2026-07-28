import type { MergedPR } from "./gh.ts";

export type Worktree = { path: string; branch: string };

export type SplitGroup = {
  session: string;
  integrationBranch: string | null;
  sliceBranches: string[];
  worktreePaths: string[];
};

export type CleanupDeps = {
  // Live git worktrees (any location; filtered here to the worktrees dir).
  listWorktrees: () => Worktree[];
  // The viewer's merged PRs (number + head branch), gh-backed hence async.
  listMergedPRs: () => Promise<MergedPR[]>;
  // Only worktrees under this directory are torn down, so the main checkout is
  // never touched even if a branch name somehow collides.
  worktreesDir: string;
  // Tear down a worktree by its branch (== its ticket session name): docker down,
  // worktree remove, branch delete, kill the branch-named session. Via end-session.sh.
  teardown: (branch: string) => void;
  // Live tmux session names, for the pr-<n>-fix session scan below.
  listSessions: () => string[];
  // Kill a tmux session by exact name (a merged PR's fix session).
  killSession: (session: string) => void;
  log: (msg: string) => void;
};

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
    const integration = worktrees.find((w) => w.path === `${prefix}${session}`) ?? null;
    const worktreePaths = slices.map((s) => s.path);
    if (integration) worktreePaths.push(integration.path);
    groups.push({
      session,
      integrationBranch: integration ? integration.branch : null,
      sliceBranches: slices.map((s) => s.branch),
      worktreePaths,
    });
  }
  return groups;
}

// A group is ready to tear down only when every slice PR has merged. The
// integration branch has no PR, so it is never part of the check.
export function groupReady(group: SplitGroup, mergedBranches: Set<string>): boolean {
  return group.sliceBranches.length > 0 && group.sliceBranches.every((b) => mergedBranches.has(b));
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

const FIX_SESSION_RE = /^pr-(\d+)-fix$/;

// Live "pr-<n>-fix" sessions whose PR number is in the merged set. A fix session
// is named by PR number (not branch), so the branch-keyed worktree teardown never
// targets it; and it can outlive its worktree (the worktree may already be gone).
// So it is reconciled directly against the merged-PR numbers here.
export function selectMergedFixSessions(sessions: string[], mergedPrNumbers: Set<number>): string[] {
  return sessions.filter((s) => {
    const m = FIX_SESSION_RE.exec(s);
    return m !== null && mergedPrNumbers.has(Number(m[1]));
  });
}

// One cleanup-step tick, run every heartbeat. Two independent reconciliations
// against the viewer's merged PRs: (a) tear down each merged worktree (removes the
// worktree + its branch-named ticket session), and (b) kill each live pr-<n>-fix
// session whose PR merged. Both are self-deduping (a removed worktree / killed
// session is simply gone next tick), so there is no seen-set. Every external call
// is wrapped so a failure logs and continues, never crashing the heartbeat.
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

  // (a) merged worktrees → tear down worktree + branch-named ticket session.
  for (const w of selectMergedWorktrees(worktrees, mergedBranches, deps.worktreesDir)) {
    try {
      deps.teardown(w.branch);
      deps.log(`torn down ${w.branch} (PR merged)`);
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
