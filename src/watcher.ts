import { execFileSync, spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { selectNextClaim } from "./claim.ts";
import { type CleanupDeps, cleanupOnce, type Worktree } from "./cleanup.ts";
import {
  countAssignedInState,
  type CycleTodoIssue,
  fetchCycleTodoIssues,
  fetchIssuesInState,
  type LinearContext,
  type LinearIssue,
  moveIssueToState,
} from "./linear-api.ts";
import { fixSessionName, type PrReviewDeps, reviewOnce } from "./pr-review.ts";

export const sessionScriptPath = join(homedir(), "new-session.sh");
export const endSessionScriptPath = join(homedir(), "end-session.sh");
export const worktreesDir = join(homedir(), "Work/worktrees");

// tmux user option + glyph marking a session's feature as ready for the user to
// run local dev and test. Session-scoped, so it clears for free when the session
// ends; displayed by window-status / choose-tree in ~/.config/tmux/tmux.conf.
export const featureReadyOption = "@feature_status";
export const featureReadyGlyph = "#[fg=cyan]▶";

export type WatchState = {
  seen: Set<string>;
  initialized: boolean;
};

export type WatcherDeps = {
  fetchIssues: () => Promise<LinearIssue[]>;
  // Handle one newly-appeared issue. `name` is the buildSessionName slug (used
  // by the deploy action); `issue` is passed for actions that need the raw
  // identifier (e.g. the review-icon action's prefix match).
  launch: (name: string, issue: LinearIssue) => Promise<void> | void;
  log: (msg: string) => void;
};

// Must produce names new-session.sh's sanitization ([a-zA-Z0-9-], 50 chars)
// passes through unchanged, so the tmux session and worktree dir agree.
export function buildSessionName(identifier: string, title: string): string {
  return `${identifier}-${title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 50)
    .replace(/^-+|-+$/g, "");
}

// The tmux session / worktree dir a branch maps to, mirroring new-session.sh's
// rule exactly (`sed 's/[^a-zA-Z0-9-]/-/g' | cut -c1-50`). A ticket session is
// launched with name == branch, so a PR's head branch resolves to its ticket
// session name; the fix guard looks for a window there.
export function sanitizeBranchToSession(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 50);
}

// The sanitized identifier plus a trailing dash — the shared prefix of the
// tmux session name and worktree dir new-session.sh created for this issue.
// The trailing dash is a boundary so ENG-4 never matches an eng-42-* name.
function identifierPrefix(identifier: string): string {
  return `${identifier.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}-`;
}

// Find the tmux session or ~/Work/worktrees dir belonging to this issue by
// matching on the identifier prefix, so a title edit since creation (which
// would change the slug tail) still resolves. Sessions are considered before
// worktrees; ties break by sort order for determinism. Null if nothing matches.
export function findExistingSession(
  identifier: string,
  sessions: string[],
  worktrees: string[],
): string | null {
  const prefix = identifierPrefix(identifier);
  const candidates = [...sessions, ...worktrees].filter((name) => name.startsWith(prefix)).sort();
  return candidates[0] ?? null;
}

export type FeatureReadyDeps = {
  listSessions: () => string[];
  listWorktrees: () => string[];
  markReady: (session: string) => void;
  log: (msg: string) => void;
};

// Action for the review-icon step: when an issue enters "In Review", flag its
// existing session as feature-ready-to-test (a tmux status glyph) so the user
// knows they can run local dev there. No-op (just logs) if no session matches.
// Fires once per issue via the poll's seen-set, so a manual clear of the icon
// isn't re-applied on the next heartbeat.
export function markFeatureReady(issue: LinearIssue, deps: FeatureReadyDeps): void {
  const match = findExistingSession(issue.identifier, deps.listSessions(), deps.listWorktrees());
  if (!match) {
    deps.log(`no existing session for ${issue.identifier}, skipping ready-to-test flag`);
    return;
  }
  deps.markReady(match);
  deps.log(`flagged ${match} ready to test for ${issue.identifier}`);
}

export function detectNewIssues(state: WatchState, issues: LinearIssue[]): LinearIssue[] {
  if (!state.initialized) {
    // Issues already in the watched state at startup are the baseline;
    // only transitions that happen while we're running launch sessions.
    for (const issue of issues) state.seen.add(issue.id);
    state.initialized = true;
    return [];
  }
  return issues.filter((issue) => !state.seen.has(issue.id));
}

export async function pollOnce(state: WatchState, deps: WatcherDeps): Promise<void> {
  let issues: LinearIssue[];
  try {
    issues = await deps.fetchIssues();
  } catch (err) {
    deps.log(`poll failed: ${err}`);
    return;
  }

  for (const issue of detectNewIssues(state, issues)) {
    const name = buildSessionName(issue.identifier, issue.title);
    try {
      await deps.launch(name, issue);
      // Mark seen only after the action succeeds so failures retry next poll.
      // (Success logging is the action's responsibility — it varies per step.)
      state.seen.add(issue.id);
    } catch (err) {
      deps.log(`failed to handle ${issue.identifier}: ${err}`);
    }
  }
}

export type ClaimDeps = {
  // Whether the autonomous claim step is enabled at all.
  autoClaim: boolean;
  // Label names that disqualify a ticket from being claimed.
  riskLabels: string[];
  // Ceiling on the personal In-Progress WIP: the claim step acts only while the
  // count is below this. 1 restores the old one-at-a-time behavior.
  maxInProgress: number;
  // Viewer-wide count (across all teams) of the personal In-Progress WIP.
  countInProgress: () => Promise<number>;
  // The watched team's active-cycle Todo issues assigned to the viewer.
  fetchCycleTodos: () => Promise<CycleTodoIssue[]>;
  // Move the chosen ticket into the watched "In Progress" state, so the
  // deploy step picks it up on the next poll.
  moveToInProgress: (issue: CycleTodoIssue) => Promise<void>;
  log: (msg: string) => void;
};

// One tick of the claim step. Gated by the WIP cap: acts while fewer than
// maxInProgress tickets are In Progress (there is no review-queue cap — in-review
// PRs are worked automatically by the review step). It claims at most one ticket
// per tick, so the count climbs toward the cap one heartbeat at a time. When the
// gate is open it selects the top eligible current-cycle Todo and moves it to In
// Progress — it never launches anything itself.
//
// Known limitation: launching relies on the deploy step detecting the Todo→In
// Progress transition, and that step only fires once per issue per daemon
// lifetime (its seen-set is never cleared). So if a human moves an
// already-launched ticket back to Todo, the claim step can re-pick it and move
// it to In Progress but the deploy step will ignore it — it stays In Progress
// with no session and stalls the claim step until a human intervenes. This only
// happens on a manual backward move; the normal forward flow is unaffected.
export async function claimOnce(deps: ClaimDeps): Promise<void> {
  if (!deps.autoClaim) return;

  try {
    if ((await deps.countInProgress()) >= deps.maxInProgress) return; // at WIP cap
  } catch (err) {
    deps.log(`claim failed: ${err}`);
    return;
  }

  let todos: CycleTodoIssue[];
  try {
    todos = await deps.fetchCycleTodos();
  } catch (err) {
    deps.log(`claim failed: ${err}`);
    return;
  }

  const next = selectNextClaim(todos, { riskLabels: deps.riskLabels });
  if (!next) return;

  try {
    await deps.moveToInProgress(next);
    deps.log(`claimed ${next.identifier} → In Progress`);
  } catch (err) {
    deps.log(`failed to move ${next.identifier}: ${err}`);
  }
}

export type ClaimConfig = {
  autoClaim: boolean;
  riskLabels: string[];
  maxInProgress: number;
  // Watched-team Todo context (team + Todo state + viewer) for cycle queries.
  todoContext: LinearContext;
  // State name for the viewer-wide, team-agnostic In-Progress WIP count.
  progressStateName: string;
};

export type WatcherConfig = {
  apiKey: string;
  progressContext: LinearContext;
  // Context for the In-Review Linear poll that flags a session ready-to-test.
  reviewContext: LinearContext;
  heartbeatIntervalMinutes: number;
  claim: ClaimConfig;
  // gh-backed hooks for the review step; null disables PR comment handling (e.g.
  // when gh isn't available or the repo couldn't be resolved at startup).
  prReview: Pick<PrReviewDeps, "listOpenPRs" | "unresolvedCount"> | null;
  // gh-backed hooks for the cleanup step; null disables it (AUTO_CLEANUP off, or
  // gh unavailable). When set, each heartbeat tears down the worktree + session
  // of every merged PR whose branch has a worktree under worktreesDir.
  cleanup: { codebasePath: string; listMergedBranches: () => Set<string> } | null;
};

export function launchSession(name: string): Promise<void> {
  const proc = spawn("bash", [sessionScriptPath, name], { detached: true, stdio: "ignore" });
  proc.unref();
  // spawn() reports failures like ENOENT asynchronously via 'error'; wait for
  // the 'spawn' event so callers can treat a failed launch as an error and retry.
  const result = new Promise<void>((resolve, reject) => {
    proc.once("spawn", () => resolve());
    proc.once("error", (err) => reject(err));
  });
  // Diagnostic only: the session script runs detached, so a non-zero exit
  // (e.g. tmux/worktree setup failing inside the script) would otherwise be
  // invisible — this does not affect the seen/retry semantics above.
  proc.once("exit", (code) => {
    if (code !== 0) console.error(`[watcher] new-session.sh for '${name}' exited ${code}`);
  });
  return result;
}

// Launch a PR fix run: new-session.sh <pr-<n>-fix> <branch>. The script reuses
// the branch's worktree and, when the branch's ticket session is still alive,
// adds the fix as a window there; otherwise it falls back to a standalone
// pr-<n>-fix session. Detached and fire-and-forget — a spawn failure is logged,
// and the next heartbeat retries (nothing was created, so the guard won't block).
export function spawnFixSession(name: string, branch: string): void {
  const proc = spawn("bash", [sessionScriptPath, name, branch], { detached: true, stdio: "ignore" });
  proc.unref();
  proc.once("error", (err) => console.error(`[review] new-session.sh for '${name}' failed: ${err}`));
  proc.once("exit", (code) => {
    if (code !== 0) console.error(`[review] new-session.sh for '${name}' exited ${code}`);
  });
}

// Whether a tmux session by this name currently exists.
export function tmuxHasSession(name: string): boolean {
  try {
    execFileSync("tmux", ["has-session", "-t", `=${name}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Whether a window by this name exists in the given tmux session. False when the
// session or the tmux server is absent.
export function tmuxWindowExists(session: string, window: string): boolean {
  try {
    const out = execFileSync("tmux", ["list-windows", "-t", `=${session}`, "-F", "#{window_name}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").some((name) => name.trim() === window);
  } catch {
    return false;
  }
}

// In-flight guard for a PR's fix run. A fix lives either as a standalone
// pr-<n>-fix session (when the ticket session was gone) or as a pr-<n>-fix window
// inside the branch's ticket session. Either presence means don't re-spawn.
export function fixInFlight(prNumber: number, branch: string): boolean {
  const name = fixSessionName(prNumber);
  if (tmuxHasSession(name)) return true;
  return tmuxWindowExists(sanitizeBranchToSession(branch), name);
}

// Flag a tmux session's feature as ready to test by setting the session-scoped
// @feature_status glyph. Best-effort: tmux may not be running.
export function setFeatureReady(session: string): void {
  try {
    // Plain session name (not "=name"): set-option rejects the exact-match
    // prefix, and tmux resolves an exact session name before any prefix match.
    execFileSync("tmux", ["set-option", "-t", session, featureReadyOption, featureReadyGlyph], {
      stdio: "ignore",
    });
  } catch {
    /* tmux not running or session gone — nothing to flag */
  }
}

// Current tmux session names; empty if no server is running.
function listTmuxSessions(): string[] {
  try {
    const out = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// Worktree directory names under ~/Work/worktrees; empty if the dir is absent.
function listWorktreeDirs(): string[] {
  try {
    return readdirSync(worktreesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// Parse `git worktree list --porcelain` into path+branch pairs. Entries with no
// branch (detached HEAD, bare) are skipped: they have no branch to reconcile
// against a merged PR. Prunable entries (registration whose directory is gone)
// are skipped too: there is no worktree to clean, and selecting one would make
// end-session.sh die every heartbeat. Blocks are separated by blank lines; a
// trailing block with no final blank line is still flushed.
export function parseWorktreePorcelain(output: string): Worktree[] {
  const result: Worktree[] = [];
  let path: string | null = null;
  let branch: string | null = null;
  let prunable = false;
  const flush = () => {
    if (path && branch && !prunable) result.push({ path, branch });
    path = null;
    branch = null;
    prunable = false;
  };
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      path = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    } else if (line.startsWith("prunable")) {
      prunable = true;
    } else if (line === "") {
      flush();
    }
  }
  flush();
  return result;
}

// The live git worktrees of the codebase repo (path + branch). Empty on any git
// error (missing repo, git absent).
export function listGitWorktrees(codebasePath: string): Worktree[] {
  try {
    const out = execFileSync("git", ["-C", codebasePath, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseWorktreePorcelain(out);
  } catch {
    return [];
  }
}

// Tear down a merged branch's worktree + session via end-session.sh <branch>.
// The script runs headless (arg given), so it skips the interactive client UI and
// just kills the session by name. Detached and fire-and-forget, mirroring
// spawnFixSession: a failure is logged and the next heartbeat retries (nothing
// was removed, so the worktree still appears and is re-selected).
export function runEndSession(branch: string): void {
  const proc = spawn("bash", [endSessionScriptPath, branch], { detached: true, stdio: "ignore" });
  proc.unref();
  proc.once("error", (err) => console.error(`[cleanup] end-session.sh for '${branch}' failed: ${err}`));
  proc.once("exit", (code) => {
    if (code !== 0) console.error(`[cleanup] end-session.sh for '${branch}' exited ${code}`);
  });
}

export function startWatcher(config: WatcherConfig): () => void {
  const log = (msg: string) => console.log(`[watcher] ${msg}`);

  // Deploy step: issues entering "In Progress" → create a worktree + session.
  const deployState: WatchState = { seen: new Set(), initialized: false };
  const deployDeps: WatcherDeps = {
    fetchIssues: () => fetchIssuesInState(config.apiKey, config.progressContext),
    launch: async (name, issue) => {
      await launchSession(name);
      log(`launched session '${name}' for ${issue.identifier}`);
    },
    log,
  };

  // Review-icon poll: issues entering "In Review" → flag their session ready to
  // test (a tmux glyph). Fires once per issue via the seen-set, so a manual clear
  // of the glyph sticks.
  const reviewIconLog = (msg: string) => console.log(`[review] ${msg}`);
  const reviewIconState: WatchState = { seen: new Set(), initialized: false };
  const reviewIconDeps: WatcherDeps = {
    fetchIssues: () => fetchIssuesInState(config.apiKey, config.reviewContext),
    launch: (_name, issue) =>
      markFeatureReady(issue, {
        listSessions: listTmuxSessions,
        listWorktrees: listWorktreeDirs,
        markReady: setFeatureReady,
        log: reviewIconLog,
      }),
    log: reviewIconLog,
  };

  // Review step (gh-driven): each heartbeat, address comments on open PRs.
  const prReviewDeps: PrReviewDeps | null = config.prReview && {
    listOpenPRs: config.prReview.listOpenPRs,
    unresolvedCount: config.prReview.unresolvedCount,
    fixInFlight,
    spawnFix: spawnFixSession,
    log: reviewIconLog,
  };

  // Cleanup step (gh-driven): each heartbeat, tear down the worktree + session of
  // every merged PR whose branch still has a worktree.
  const cleanupLog = (msg: string) => console.log(`[cleanup] ${msg}`);
  const { cleanup } = config;
  const cleanupDeps: CleanupDeps | null = cleanup && {
    listWorktrees: () => listGitWorktrees(cleanup.codebasePath),
    listMergedBranches: cleanup.listMergedBranches,
    worktreesDir,
    teardown: runEndSession,
    log: cleanupLog,
  };

  // Claim step: on each heartbeat, while below the WIP cap, move the top
  // current-cycle Todo into "In Progress" so the deploy step launches it.
  const claimLog = (msg: string) => console.log(`[claim] ${msg}`);
  const { claim } = config;
  const viewerId = config.progressContext.viewerId;
  const claimDeps: ClaimDeps = {
    autoClaim: claim.autoClaim,
    riskLabels: claim.riskLabels,
    maxInProgress: claim.maxInProgress,
    countInProgress: () => countAssignedInState(config.apiKey, viewerId, claim.progressStateName),
    fetchCycleTodos: () => fetchCycleTodoIssues(config.apiKey, claim.todoContext),
    moveToInProgress: (issue) =>
      moveIssueToState(config.apiKey, issue.id, config.progressContext.stateId),
    log: claimLog,
  };

  let running = false;
  const heartbeat = async () => {
    if (running) return;
    running = true;
    try {
      await pollOnce(deployState, deployDeps);
      await pollOnce(reviewIconState, reviewIconDeps);
      if (prReviewDeps) reviewOnce(prReviewDeps);
      if (cleanupDeps) cleanupOnce(cleanupDeps);
      // The claim step MUST run last: the deploy poll fetches first, so a ticket
      // the claim step moves to In Progress this tick is launched on the NEXT
      // tick (not double-launched now), and the higher In-Progress count keeps
      // the WIP cap accounting correct.
      await claimOnce(claimDeps);
    } finally {
      running = false;
    }
  };

  const safeHeartbeat = () =>
    void heartbeat().catch((err) => console.error(`[watcher] heartbeat crashed: ${err}`));

  safeHeartbeat();
  const timer = setInterval(safeHeartbeat, config.heartbeatIntervalMinutes * 60 * 1000);
  return () => clearInterval(timer);
}
