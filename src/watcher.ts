import { execFileSync, spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AC,
  AC_COMMENT_MARKER,
  type Judgment,
  parseAcceptanceCriteria,
  renderAcComment,
} from "./acceptance.ts";
import { isBlocked, mergedIdentifierSet } from "./blocked.ts";
import { selectNextClaim } from "./claim.ts";
import { filterByLabel, type LabelFilter } from "./labels.ts";
import {
  candidateLines,
  DEPENDENCY_COMMENT_MARKER,
  normalizeDescription,
  renderDependencyComment,
} from "./dependency.ts";
import {
  type CleanupDeps,
  cleanupOnce,
  isSplitParentWorktree,
  isSplitSliceWindow,
  type OrphanSweepDeps,
  readParentSession,
  sanitizeBranchToSession,
  sweepOrphanWorktrees,
  type Worktree,
} from "./cleanup.ts";
import { deriveKey, emitEvent, emitFlagged, emitStatus, readEvents, reduceRows, titleFromBranch } from "./events.ts";
import type { ChecksInfo, MergeableInfo, MergedPR, OpenPR, UnresolvedInfo } from "./gh.ts";
import {
  countAssignedInState,
  createBlocksRelation,
  type CycleTodoIssue,
  fetchMarkedCommentBody,
  fetchCycleTodoIssues,
  fetchIssueByIdentifier,
  fetchInProgressIssuesWithBlockers,
  fetchIssuesInState,
  type IssueWithBlockers,
  type LinearContext,
  type LinearIssue,
  moveIssueToState,
  upsertMarkedComment,
} from "./linear-api.ts";
import { advanceOnce, type AdvanceDeps, freshAdvanceState } from "./pr-advance.ts";
import { boardReadyToMerge, type PrReadyDeps, readyOnce } from "./pr-ready.ts";
import {
  blockedSessionName,
  ciSessionName,
  conflictSessionName,
  type FixKind,
  fixSessionName,
  freshReviewState,
  type PrReviewDeps,
  reviewOnce,
} from "./pr-review.ts";

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

// A ticket session is launched with name == branch, so a PR's head branch
// resolves to its ticket session name; the fix guard looks for a window there.
// Re-exported from cleanup.ts, which owns the sanitize rule the split-group
// integration lookup also depends on.
export { sanitizeBranchToSession };

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

// The ticket identifier at the head of a worktree/branch slug (eng-1104, sc-42).
const WORKTREE_IDENTIFIER_RE = /^[a-z]+-\d+/;

// Whether a live tmux session belongs to the ticket owning this worktree dir.
// Matches on the identifier prefix, not the exact name, because new-session.sh
// truncates the worktree dir to 50 chars but keeps the full session name — for a
// long title the two differ. A dir whose name has no ticket identifier returns
// true (spare it): the orphan sweep must never reap an unrecognized worktree.
export function hasSessionForWorktree(worktreeName: string, sessions: string[]): boolean {
  const m = WORKTREE_IDENTIFIER_RE.exec(worktreeName.toLowerCase());
  if (!m) return true;
  return findExistingSession(m[0], sessions, []) !== null;
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

// Per-process latch of issues the deploy step has already launched or adopted.
// Not a startup baseline: unlike the review-icon poll, the deploy step must be
// restart-safe (see deployOnce), so it reconciles against live sessions instead
// of assuming everything present at startup is handled.
export type DeployState = { launched: Set<string> };

export function freshDeployState(): DeployState {
  return { launched: new Set() };
}

export type DeployDeps = {
  fetchIssues: () => Promise<LinearIssue[]>;
  listSessions: () => string[];
  listWorktrees: () => string[];
  // Create a worktree + session for a launched issue.
  launch: (name: string, issue: LinearIssue) => Promise<void> | void;
  log: (msg: string) => void;
};

// One deploy-step tick. For each In-Progress issue: skip it if already
// launched/adopted this process; else, if a session or worktree already exists
// for it, adopt it (latch, no relaunch); else launch one and latch it.
//
// This is restart-safe where the old seen-set baseline was not: after a restart
// the latch is empty, but a live ticket's existing session/worktree makes it
// adopted (never double-launched), while a genuinely orphaned In-Progress ticket
// (no session AND no worktree) is relaunched once. Because a launched/adopted
// ticket is latched for the process, the cleanup step removing its worktree after
// its PR merges does NOT retrigger a launch.
export async function deployOnce(state: DeployState, deps: DeployDeps): Promise<void> {
  let issues: LinearIssue[];
  try {
    issues = await deps.fetchIssues();
  } catch (err) {
    deps.log(`deploy poll failed: ${err}`);
    return;
  }

  const sessions = deps.listSessions();
  const worktrees = deps.listWorktrees();
  for (const issue of issues) {
    if (state.launched.has(issue.id)) continue;
    if (findExistingSession(issue.identifier, sessions, worktrees)) {
      state.launched.add(issue.id); // adopt an existing session/worktree
      continue;
    }
    const name = buildSessionName(issue.identifier, issue.title);
    try {
      await deps.launch(name, issue);
      state.launched.add(issue.id); // latch only after a successful launch, so failures retry
      deps.log(`launched session '${name}' for ${issue.identifier}`);
    } catch (err) {
      deps.log(`failed to launch ${issue.identifier}: ${err}`);
    }
  }
}

export type DependencyScanDeps = {
  // Existing yimbot dependency-scan comment body, "" when the ticket has none.
  fetchMarker: (issueId: string) => Promise<string>;
  // Blocker identifiers inferred from the description, [] when none qualify.
  scan: (identifier: string, description: string) => Promise<string[]>;
  // Resolve a ticket identifier (ENG-1319) to its Linear uuid.
  resolveId: (identifier: string) => Promise<string>;
  createRelation: (blockerId: string, blockedId: string) => Promise<void>;
  writeMarker: (issueId: string, body: string) => Promise<void>;
};

export type ClaimDeps = {
  // Whether the autonomous claim step is enabled at all.
  autoClaim: boolean;
  // Label names that disqualify a ticket from being claimed.
  riskLabels: string[];
  // Which slice of the board this instance works (LABEL_FILTER).
  labelFilter: LabelFilter;
  // Ceiling on the personal In-Progress WIP: the claim step acts only while the
  // count is below this. 1 restores the old one-at-a-time behavior.
  maxInProgress: number;
  // Viewer-wide count (across all teams) of the personal In-Progress WIP.
  countInProgress: () => Promise<number>;
  // The watched team's active-cycle Todo issues assigned to the viewer.
  fetchCycleTodos: () => Promise<CycleTodoIssue[]>;
  // Merged ticket identifiers for the blocked-by filter. Absent when gh is
  // unavailable, in which case the filter is skipped.
  fetchMergedIdentifiers?: () => Promise<Set<string>>;
  // Move the chosen ticket into the watched "In Progress" state, so the
  // deploy step picks it up on the next poll.
  moveToInProgress: (issue: CycleTodoIssue) => Promise<void>;
  // Adjudicates the picked ticket's description for a dependency never recorded
  // as a Linear relation; null or absent disables the step.
  dependencyScan?: DependencyScanDeps | null;
  log: (msg: string) => void;
};

// Adjudicate the picked ticket's description and record any blocker it names as
// a real Linear relation.
//
// Detection failures fail open ("claim"), so a broken scanner never halts the
// claim step. Blockers recorded successfully fail closed for this tick only
// ("deferred"): the ticket is now marked, so it is excluded from future scans by
// the marker check above. A write failure after blockers were identified also
// fails closed ("skip"), but since no marker was written the ticket would be
// rescanned and fail closed again every heartbeat forever, so claimOnce latches a
// "skip" verdict into the per-process skip set so this ticket alone stalls,
// not the whole claim step.
type BlockerVerdict = "claim" | "deferred" | "skip";

// Narrow the cited source lines to the ones naming a blocker actually recorded,
// not every candidate line, so the marker's audit trail matches what was really
// acted on (a description can name a rejected blocker alongside an accepted
// one). Whole-identifier boundary match, consistent with parseDependencies in
// dependency.ts. Falls back to the full candidate list if nothing matches,
// rather than emitting an empty Source section.
function linesForRecorded(lines: string[], recorded: string[]): string[] {
  const ids = recorded.map((id) => id.toUpperCase());
  const filtered = lines.filter((line) => {
    const upper = line.toUpperCase();
    return ids.some((id) => new RegExp(`\\b${id}\\b`).test(upper));
  });
  return filtered.length > 0 ? filtered : lines;
}

async function recordInferredBlockers(
  scan: DependencyScanDeps,
  next: CycleTodoIssue,
  log: (msg: string) => void,
): Promise<BlockerVerdict> {
  // Free prefilter first: a description with no candidate lines has nothing to
  // scan, so skip the marker fetch entirely rather than paying a network call
  // for the common case of a description that never mentions another ticket.
  const normalized = normalizeDescription(next.description);
  const lines = candidateLines(normalized);
  if (lines.length === 0) return "claim";

  let blockers: string[];
  try {
    if ((await scan.fetchMarker(next.id)) !== "") return "claim";
    blockers = await scan.scan(next.identifier, next.description);
  } catch (err) {
    log(`dependency scan failed for ${next.identifier}: ${err}`);
    return "claim";
  }
  if (blockers.length === 0) return "claim";

  const recorded: string[] = [];
  try {
    for (const identifier of blockers) {
      let blockerId: string;
      try {
        blockerId = await scan.resolveId(identifier);
      } catch (err) {
        log(`dependency scan: ${identifier} did not resolve, skipping: ${err}`);
        continue;
      }
      await scan.createRelation(blockerId, next.id);
      recorded.push(identifier);
    }
    if (recorded.length === 0) return "claim";
    await scan.writeMarker(
      next.id,
      renderDependencyComment(next.identifier, recorded, linesForRecorded(lines, recorded)),
    );
  } catch (err) {
    log(`dependency scan: failed to record blockers for ${next.identifier}: ${err}`);
    return "skip";
  }
  log(`inferred ${next.identifier} blocked by ${recorded.join(", ")} from its description; wrote relation`);
  return "deferred";
}

// Per-process latch of tickets a write-failed dependency-scan adjudication has
// skipped. Without this, a ticket whose marker write keeps failing is the
// deterministic top pick forever: every heartbeat rescans it (an LLM call),
// fails closed on the same write, and the claim step never reaches any other
// ticket. Latching it here lets the next tick fall through to the
// next-priority ticket instead, so only the broken ticket stalls.
export type ClaimState = { skip: Set<string> };

export function freshClaimState(): ClaimState {
  return { skip: new Set() };
}

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
export async function claimOnce(state: ClaimState, deps: ClaimDeps): Promise<void> {
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
  todos = todos.filter((t) => !state.skip.has(t.id));
  // Filtered once, up front, so the deferral logging below and selectNextClaim
  // agree on which todos are actually in this instance's slice.
  const inSlice = filterByLabel(deps.labelFilter, todos);

  let merged: Set<string> | null = null;
  if (deps.fetchMergedIdentifiers) {
    try {
      merged = await deps.fetchMergedIdentifiers();
    } catch (err) {
      deps.log(`claim failed: ${err}`);
      return;
    }
    for (const t of inSlice) {
      if (isBlocked(t.blockedBy, merged)) {
        deps.log(`deferring ${t.identifier}: blocked by ${t.blockedBy.join(", ")} (unmerged)`);
      }
    }
  }

  const next = selectNextClaim(inSlice, { riskLabels: deps.riskLabels, merged, labelFilter: deps.labelFilter });
  if (!next) return;

  // Runs on this one ticket only. claimOnce already returned early at the WIP
  // cap, so this is at most one adjudication per heartbeat.
  if (deps.dependencyScan) {
    const verdict = await recordInferredBlockers(deps.dependencyScan, next, deps.log);
    if (verdict === "skip") state.skip.add(next.id);
    if (verdict !== "claim") return;
  }

  try {
    await deps.moveToInProgress(next);
    deps.log(`claimed ${next.identifier} → In Progress`);
  } catch (err) {
    deps.log(`failed to move ${next.identifier}: ${err}`);
  }
}

export type ReconcileDeps = {
  // The viewer's In-Progress issues in the watched team, with their blockers.
  fetchInProgress: () => Promise<IssueWithBlockers[]>;
  // Merged ticket identifiers, for the blocked check.
  fetchMergedIdentifiers: () => Promise<Set<string>>;
  // Move a blocked issue back to Todo.
  moveToTodo: (issueId: string) => Promise<void>;
  // Drop an issue id from the deploy latch so it relaunches once unblocked.
  unlatchDeploy: (issueId: string) => void;
  log: (msg: string) => void;
};

// One tick of the reconcile step. Moves every In-Progress ticket whose blocker
// has no merged PR back to Todo and clears the deploy latch, so it is out of the
// deploy poll's In-Progress set before deploy runs (a blocked ticket never gets
// launched) and a later re-claim relaunches it once unblocked. It never tears the
// worktree/session down: a worktree lives until its PR resolves, so a ticket that
// was already launched before it became blocked keeps its in-progress work. Runs
// before deploy so a just-moved-back ticket is already Todo when deploy looks.
// Each ticket is isolated: one failure does not abort the rest.
export async function reconcileBlockedInProgress(deps: ReconcileDeps): Promise<void> {
  let issues: IssueWithBlockers[];
  try {
    issues = await deps.fetchInProgress();
  } catch (err) {
    deps.log(`reconcile failed: ${err}`);
    return;
  }

  let merged: Set<string>;
  try {
    merged = await deps.fetchMergedIdentifiers();
  } catch (err) {
    deps.log(`reconcile failed: ${err}`);
    return;
  }

  for (const issue of issues) {
    if (!isBlocked(issue.blockedBy, merged)) continue;
    const unmerged = issue.blockedBy.filter((id) => !merged.has(id.toUpperCase())).join(", ");
    try {
      await deps.moveToTodo(issue.id);
      deps.unlatchDeploy(issue.id);
      deps.log(`moved ${issue.identifier} back to Todo: blocked by ${unmerged} (unmerged)`);
    } catch (err) {
      deps.log(`failed to move ${issue.identifier} back: ${err}`);
    }
  }
}

export type ClaimConfig = {
  autoClaim: boolean;
  riskLabels: string[];
  labelFilter: LabelFilter;
  maxInProgress: number;
  // Watched-team Todo context (team + Todo state + viewer) for cycle queries.
  todoContext: LinearContext;
  // State name for the viewer-wide, team-agnostic In-Progress WIP count.
  progressStateName: string;
};

export type WatcherConfig = {
  apiKey: string;
  // Which slice of the board this instance works; applied to every step.
  labelFilter: LabelFilter;
  progressContext: LinearContext;
  // Context for the In-Review Linear poll that flags a session ready-to-test.
  reviewContext: LinearContext;
  heartbeatIntervalMinutes: number;
  // How long a fix session may stay in flight before the reaper tears it down as
  // stale, regardless of PR state (backstop for bailed/crashed/stuck sessions and
  // for comment fixes, which have no crisp PR-state objective).
  reapStaleMs: number;
  claim: ClaimConfig;
  // gh-backed hooks for the review step; null disables PR comment + CI handling
  // (e.g. when gh isn't available or the repo couldn't be resolved at startup).
  prReview: Pick<PrReviewDeps, "listOpenPRs" | "unresolvedInfo" | "mergeableInfo" | "checksInfo" | "blockedInfo" | "changesRequested"> | null;
  // gh-backed hooks for the cleanup step; null disables it (AUTO_CLEANUP off, or
  // gh unavailable). When set, each heartbeat tears down the worktree + session
  // of every merged PR whose branch has a worktree under worktreesDir.
  cleanup: {
    codebasePath: string;
    listMergedPRs: () => Promise<MergedPR[]>;
    listClosedUnmergedPRs: () => Promise<MergedPR[]>;
    listOpenPRs: () => Promise<OpenPR[]>;
    // Linear state type of an issue by identifier, for the no-PR (spike) reap.
    issueStateType: (identifier: string) => Promise<string | null>;
  } | null;
  // gh-backed hooks for the advance step; null disables it (AUTO_CONTINUE off, or
  // gh unavailable). When set, each heartbeat judges merged PRs' issues against
  // their AC tracker and spawns a continuation while criteria remain.
  advance: {
    listMergedPRs: () => Promise<MergedPR[]>;
    fetchAcComment: (issueId: string) => Promise<string>;
    fetchDescription: (identifier: string) => Promise<{ id: string; description: string }>;
    judge: (open: AC[]) => Promise<Judgment>;
    writeAcComment: (issueId: string, body: string) => Promise<void>;
    activeCount: () => Promise<number>;
    maxInProgress: number;
    maxRounds: number;
  } | null;
  // gh-backed hooks for the ready step; null disables it (AUTO_READY_LABEL off, or
  // gh unavailable). When set, each heartbeat keeps the ready label in sync on
  // each non-draft open PR: present when the PR is clean on all three signals
  // (no unresolved threads, mergeable, CI passing/none), absent otherwise.
  ready: {
    listOpenPRs: () => Promise<OpenPR[]>;
    unresolvedInfo: (n: number) => Promise<UnresolvedInfo>;
    mergeableInfo: (n: number) => Promise<MergeableInfo>;
    checksInfo: (n: number) => Promise<ChecksInfo>;
    prLabels: (n: number) => Promise<string[]>;
    addLabel: (n: number, label: string) => Promise<void>;
    removeLabel: (n: number, label: string) => Promise<void>;
    label: string;
    blockedLabel: string;
  } | null;
  // gh-backed source for the blocked-by handling (claim deferral + reconcile
  // move-back); null disables both (gh unavailable). Reuses listMyMergedPRs.
  blocked: {
    listMergedPRs: () => Promise<MergedPR[]>;
  } | null;
  // Adjudicator for dependencies stated only in a ticket's description; null
  // disables the scan. The Linear side is built here from config.apiKey.
  dependencyScan: {
    scan: (identifier: string, description: string) => Promise<string[]>;
  } | null;
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

// Re-couple a session-less worktree to a fresh tmux session on the EXISTING
// worktree, resuming its prior conversation (SESSION_RESUME=1 → claude --continue)
// so in-progress work is never re-run from the seed. new-session.sh reuses the
// registered worktree and names the session after the branch. Detached and
// fire-and-forget, mirroring launchSession: a failure is logged and the next
// heartbeat retries (nothing was created, so the guard won't block).
export function reattachSession(branch: string): void {
  console.log(`[reattach] re-coupling session to worktree '${branch}' (resume)`);
  const proc = spawn("bash", [sessionScriptPath, branch], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, SESSION_RESUME: "1" },
  });
  proc.unref();
  proc.once("error", (err) => console.error(`[reattach] new-session.sh for '${branch}' failed: ${err}`));
  proc.once("exit", (code) => {
    if (code !== 0) console.error(`[reattach] new-session.sh for '${branch}' exited ${code}`);
  });
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

// The tmux session name for an AC continuation run. Keyed by issue number and
// round so repeated continuations on the same issue get distinct sessions.
export function continuationSessionName(issueNumber: string, round: number): string {
  return `eng-${issueNumber}-cont-${round}`;
}

// Launch an AC continuation run: new-session.sh eng-<n>-cont-<round>. A fresh
// branch off main (single arg, no worktree reuse) whose seed routes to the
// pickup-ticket skill scoped by the issue's open ACs.
export function spawnContinuationSession(issueNumber: string, round: number): void {
  const name = continuationSessionName(issueNumber, round);
  const proc = spawn("bash", [sessionScriptPath, name], { detached: true, stdio: "ignore" });
  proc.unref();
  proc.once("error", (err) => console.error(`[advance] new-session.sh for '${name}' failed: ${err}`));
  proc.once("exit", (code) => {
    if (code !== 0) console.error(`[advance] new-session.sh for '${name}' exited ${code}`);
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

// Kill a tmux session by exact name. Best-effort: no-op if tmux is not running or
// the session is already gone. Used by the cleanup step for merged PRs' fix sessions.
export function killTmuxSession(name: string): void {
  try {
    execFileSync("tmux", ["kill-session", "-t", `=${name}`], { stdio: "ignore" });
  } catch {
    /* tmux not running or session already gone */
  }
}

// Kill a single tmux window by "session:window". Best-effort: no-op if tmux is
// not running or the window is already gone. Used by the reaper to end a fix that
// runs as a window inside the branch's ticket session, leaving the session alive.
export function killTmuxWindow(session: string, window: string): void {
  try {
    execFileSync("tmux", ["kill-window", "-t", `=${session}:${window}`], { stdio: "ignore" });
  } catch {
    /* tmux not running or window already gone */
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

// The window names of a tmux session. Empty when the session or server is absent.
export function listTmuxWindows(session: string): string[] {
  try {
    const out = execFileSync("tmux", ["list-windows", "-t", `=${session}`, "-F", "#{window_name}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// The session/window name for a PR's fix of a given kind.
function fixNameForKind(prNumber: number, kind: FixKind): string {
  return kind === "fix"
    ? fixSessionName(prNumber)
    : kind === "ci"
      ? ciSessionName(prNumber)
      : kind === "conflict"
        ? conflictSessionName(prNumber)
        : blockedSessionName(prNumber);
}

// Which fix kinds are currently in flight for a PR. A fix (comment `pr-<n>-fix`,
// CI `pr-<n>-ci`, conflict `pr-<n>-conflict`, or blocked `pr-<n>-blocked`) lives
// either as a standalone session (when the ticket session was gone) or as a
// window inside the branch's ticket session. Any present kind means a fixer is
// on this PR's shared worktree.
export function inFlightFixKinds(prNumber: number, branch: string): FixKind[] {
  const ticketSession = sanitizeBranchToSession(branch);
  const kinds: FixKind[] = [];
  for (const kind of ["fix", "ci", "conflict", "blocked"] as FixKind[]) {
    const name = fixNameForKind(prNumber, kind);
    if (tmuxHasSession(name) || tmuxWindowExists(ticketSession, name)) kinds.push(kind);
  }
  return kinds;
}

// Tear down a PR's fix of a given kind: kill the standalone `pr-<n>-<kind>`
// session if it exists, otherwise the same-named window inside the ticket
// session. Never touches the worktree (shared with the ticket session).
export function reapFix(prNumber: number, branch: string, kind: FixKind): void {
  const name = fixNameForKind(prNumber, kind);
  if (tmuxHasSession(name)) {
    killTmuxSession(name);
    return;
  }
  const ticketSession = sanitizeBranchToSession(branch);
  if (tmuxWindowExists(ticketSession, name)) killTmuxWindow(ticketSession, name);
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
export function listTmuxSessions(): string[] {
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

// The deriveKey() keys of the codebase's worktrees under `dir` — the set the TUI
// intersects its event rows against so the board shows exactly the live worktrees.
// Filtered to `dir` so the main checkout and unrelated worktrees are excluded;
// each branch maps through deriveKey, matching how every step keys its events.
export function worktreeKeysUnder(worktrees: Worktree[], dir: string): Set<string> {
  const prefix = dir.endsWith("/") ? dir : `${dir}/`;
  const keys = new Set<string>();
  for (const w of worktrees) {
    if (!w.path.startsWith(prefix)) continue;
    keys.add(deriveKey({ branch: w.branch }).key);
  }
  return keys;
}

export function liveWorktreeKeys(codebasePath: string, dir: string = worktreesDir): Set<string> {
  return worktreeKeysUnder(listGitWorktrees(codebasePath), dir);
}

// The live tmux session backing a board row's key, so the TUI can jump to it.
// Finds the worktree whose branch maps to `key` (the same deriveKey the board
// uses), then the session for that branch: exact name first, else the identifier
// prefix so a title edit since launch still resolves. Null when no worktree backs
// the key (e.g. a merged/PR-only row) or no session is live.
export function resolveSessionForKey(
  key: string,
  worktrees: Worktree[],
  sessions: string[],
): string | null {
  const wt = worktrees.find((w) => deriveKey({ branch: w.branch }).key === key);
  if (!wt) return null;
  if (sessions.includes(wt.branch)) return wt.branch;
  const m = WORKTREE_IDENTIFIER_RE.exec(wt.branch.toLowerCase());
  return m ? findExistingSession(m[0], sessions, []) : null;
}

// Switch the current tmux client to `session`. No-op returning false when not
// inside tmux (nothing to switch) or the session is gone — the TUI stays put.
export function switchToSession(session: string): boolean {
  if (!process.env.TMUX) return false;
  try {
    execFileSync("tmux", ["switch-client", "-t", `=${session}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Argv for the server-wide tmux binding that switches back to the board. Split
// out from the exec calls so the argv is unit-testable. The target is the
// board's pane id, not its session: a `switch-client` aimed at a session lands
// on whichever window that session last had current, so a session-only target
// misses the board whenever another window there is active. A pane id also
// survives renames and window renumbering.
export function returnKeyBindArgs(pane: string, key: string): string[] {
  return ["bind-key", "-T", "prefix", key, "switch-client", "-t", pane];
}

export function returnKeyUnbindArgs(key: string): string[] {
  return ["unbind-key", "-T", "prefix", key];
}

// The pane this process runs in, or null when it is not under tmux.
export function currentTmuxPane(): string | null {
  if (!process.env.TMUX) return null;
  return process.env.TMUX_PANE || null;
}

// Mirrors switchToSession's guard: outside tmux there is no server this
// process belongs to, so shelling out would hit whatever default socket tmux
// picks rather than the intended one.
export function bindReturnKey(pane: string, key: string): boolean {
  if (!process.env.TMUX) return false;
  try {
    execFileSync("tmux", returnKeyBindArgs(pane, key), { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function unbindReturnKey(key: string): void {
  if (!process.env.TMUX) return;
  try {
    execFileSync("tmux", returnKeyUnbindArgs(key), { stdio: "ignore" });
  } catch {
    /* tmux not running, or the key was never bound */
  }
}

// Whether `git status --porcelain` output holds any change other than yimbot's own
// marker files (.yimbot-parent-session, .yimbot-launching, .yimbot-split-parent).
// Those are daemon metadata written into the worktree, not user work, so a worktree
// dirty only with markers must still count as clean for reap decisions — otherwise a
// split parent or slice, which always carries a marker, would look permanently dirty.
export function porcelainHasNonMarkerChanges(porcelain: string): boolean {
  return porcelain
    .split("\n")
    .filter((l) => l.length > 3)
    .some((l) => !/(^|\/)\.yimbot-[^/]*$/.test(l.slice(3)));
}

// Whether a worktree holds no work teardown would destroy: a clean working tree
// AND no commit that lives only locally (every commit on HEAD is reachable from
// some origin ref, so it survives on the remote and is recoverable). Spares only
// genuinely local work — the right test both for a closed PR, whose commits never
// reach the base ref but are safely on its origin branch, and for a never-pushed
// spike branch sitting at a pushed ref's tip, which holds nothing of its own. Any
// git error → false (the reapers then keep the worktree rather than risk losing work).
export function worktreeFullyPushed(worktreePath: string): boolean {
  try {
    const dirty = execFileSync("git", ["-C", worktreePath, "status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (porcelainHasNonMarkerChanges(dirty)) return false;
    const localOnly = execFileSync(
      "git",
      ["-C", worktreePath, "rev-list", "--count", "HEAD", "--not", "--remotes=origin"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return localOnly === "0";
  } catch {
    return false;
  }
}

// Milliseconds since a worktree dir was last modified. A stat failure returns 0
// (treated as brand-new → spared), so a vanished dir is never swept.
export function worktreeAgeMs(worktreePath: string): number {
  try {
    return Date.now() - statSync(worktreePath).mtimeMs;
  } catch {
    return 0;
  }
}

// How long a .yimbot-launching marker is honored. Well above any realistic setup
// hook, but finite so a leaked marker (new-session.sh SIGKILL'd / OOM'd / the box
// rebooted mid-launch) eventually stops protecting a dead worktree, letting the
// sweep self-heal it instead of blocking it forever.
export const LAUNCH_MARKER_TTL_MS = 30 * 60 * 1000;

// Whether a launch marker still counts as an in-progress launch: present AND
// younger than the TTL. `mtimeMs` is null when the marker is absent. A stale
// marker returns false so the worktree falls back to the normal sweep guards.
export function isLaunchMarkerActive(mtimeMs: number | null, nowMs: number, ttlMs: number): boolean {
  return mtimeMs !== null && nowMs - mtimeMs < ttlMs;
}

// IO wrapper: does this worktree have a live (non-stale) launch marker? A stat
// error means no readable marker → not launching (fall back to the other guards).
export function launchMarkerActive(worktreePath: string, ttlMs: number): boolean {
  let mtimeMs: number | null;
  try {
    mtimeMs = statSync(join(worktreePath, ".yimbot-launching")).mtimeMs;
  } catch {
    mtimeMs = null;
  }
  return isLaunchMarkerActive(mtimeMs, Date.now(), ttlMs);
}

// Tear down a merged branch's worktree + session via end-session.sh <branch>.
// The script runs headless (arg given), so it skips the interactive client UI and
// just kills the session by name. Detached and fire-and-forget, mirroring
// spawnFixSession: a failure is logged and the next heartbeat retries (nothing
// was removed, so the worktree still appears and is re-selected). `reason` names
// the step that triggered the reap so daemon.log records which teardowns yimbot
// initiated (a worktree gone with no such line was removed out of band).
export function runEndSession(branch: string, reason: string): void {
  console.log(`[teardown] reaping worktree + session '${branch}' (${reason})`);
  const proc = spawn("bash", [endSessionScriptPath, branch], { detached: true, stdio: "ignore" });
  proc.unref();
  proc.once("error", (err) => console.error(`[teardown] end-session.sh for '${branch}' failed: ${err}`));
  proc.once("exit", (code) => {
    if (code !== 0) console.error(`[teardown] end-session.sh for '${branch}' exited ${code}`);
  });
}

export function startWatcher(config: WatcherConfig): () => void {
  const log = (msg: string) => console.log(`[watcher] ${msg}`);

  // Deploy step: issues in "In Progress" → create a worktree + session. Reconciles
  // against live sessions/worktrees each tick (restart-safe), so it is given the
  // session/worktree listers rather than a startup baseline.
  const deployState = freshDeployState();
  const deployDeps: DeployDeps = {
    fetchIssues: async () =>
      filterByLabel(config.labelFilter, await fetchIssuesInState(config.apiKey, config.progressContext)),
    listSessions: listTmuxSessions,
    listWorktrees: listWorktreeDirs,
    launch: (name) => {
      const { key, label } = deriveKey({ branch: name });
      emitEvent({ kind: "task_started", key, label, title: titleFromBranch(name) });
      return launchSession(name);
    },
    log,
  };

  // Review-icon poll: issues entering "In Review" → flag their session ready to
  // test (a tmux glyph). Fires once per issue via the seen-set, so a manual clear
  // of the glyph sticks.
  const reviewIconLog = (msg: string) => console.log(`[review] ${msg}`);
  const reviewIconState: WatchState = { seen: new Set(), initialized: false };
  const reviewIconDeps: WatcherDeps = {
    fetchIssues: async () =>
      filterByLabel(config.labelFilter, await fetchIssuesInState(config.apiKey, config.reviewContext)),
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
  const reviewState = freshReviewState();
  const prReviewDeps: PrReviewDeps | null = config.prReview && {
    listOpenPRs: config.prReview.listOpenPRs,
    unresolvedInfo: config.prReview.unresolvedInfo,
    mergeableInfo: config.prReview.mergeableInfo,
    checksInfo: config.prReview.checksInfo,
    blockedInfo: config.prReview.blockedInfo,
    changesRequested: config.prReview.changesRequested,
    // A changes-requested review means a human reviewer is blocking: raise the
    // board's attention flag every tick the block persists (emitFlagged dedupes
    // while it is already up, and re-raises after a manual unflag).
    onChangesRequested: (prNumber, branch) => {
      const { key, label } = deriveKey({ branch });
      emitFlagged({ key, label, title: titleFromBranch(branch), pr: prNumber, reason: "changes-requested" });
    },
    inFlightFixKinds,
    reapFix,
    now: Date.now,
    reapStaleMs: config.reapStaleMs,
    spawnFix: (name, branch, prNumber) => {
      const { key, label } = deriveKey({ branch });
      emitEvent({ kind: "review_started", key, label, title: titleFromBranch(branch), pr: prNumber });
      spawnFixSession(name, branch);
    },
    spawnCiFix: (name, branch, prNumber) => {
      const { key, label } = deriveKey({ branch });
      emitEvent({ kind: "ci_fix_started", key, label, title: titleFromBranch(branch), pr: prNumber });
      spawnFixSession(name, branch);
    },
    spawnConflictFix: (name, branch, prNumber) => {
      const { key, label } = deriveKey({ branch });
      emitEvent({ kind: "conflict_fix_started", key, label, title: titleFromBranch(branch), pr: prNumber });
      spawnFixSession(name, branch);
    },
    spawnBlockedFix: (name, branch, prNumber) => {
      const { key, label } = deriveKey({ branch });
      emitEvent({ kind: "blocked_fix_started", key, label, title: titleFromBranch(branch), pr: prNumber });
      spawnFixSession(name, branch);
    },
    log: reviewIconLog,
  };

  // Cleanup step (gh-driven): each heartbeat, tear down the worktree + session of
  // every merged PR whose branch still has a worktree.
  const cleanupLog = (msg: string) => console.log(`[cleanup] ${msg}`);
  const { cleanup } = config;
  const cleanupDeps: CleanupDeps | null = cleanup && {
    listWorktrees: () => listGitWorktrees(cleanup.codebasePath),
    listMergedPRs: cleanup.listMergedPRs,
    listClosedUnmergedPRs: cleanup.listClosedUnmergedPRs,
    listOpenPRs: cleanup.listOpenPRs,
    issueStateType: cleanup.issueStateType,
    hasNoUnpushedWork: worktreeFullyPushed,
    worktreesDir,
    teardown: (branch) => {
      const { key, label } = deriveKey({ branch });
      emitStatus({ kind: "merged", key, label, title: titleFromBranch(branch) });
      runEndSession(branch, "cleanup (merged/closed PR or done ticket)");
    },
    // Every tick, transition any board row still shown as active to merged once its
    // PR has merged, even with no worktree left for teardown to emit against (the
    // worktree was reaped, or cleaned up out of band). Scoped to keys already on the
    // board so a backlog of old merges never spawns fresh rows.
    reconcileMerged: (mergedBranches) => {
      const active = new Set(
        reduceRows(readEvents(), Date.now())
          .filter((r) => !r.terminal)
          .map((r) => r.key),
      );
      for (const branch of mergedBranches) {
        const { key, label } = deriveKey({ branch });
        if (active.has(key)) emitStatus({ kind: "merged", key, label, title: titleFromBranch(branch) });
      }
    },
    listSessions: listTmuxSessions,
    killSession: killTmuxSession,
    readParentSession,
    // A worktree dir maps to its tmux session by the sanitize rule (dir ==
    // sanitize(session)); reverse it against the live sessions, then check that
    // session for live "PR (i/n)" slice windows.
    hasActiveSplitWindows: (w) => {
      const prefix = worktreesDir.endsWith("/") ? worktreesDir : `${worktreesDir}/`;
      if (!w.path.startsWith(prefix)) return false;
      const dir = w.path.slice(prefix.length);
      const session = listTmuxSessions().find((s) => sanitizeBranchToSession(s) === dir);
      return session != null && listTmuxWindows(session).some(isSplitSliceWindow);
    },
    isSplitParent: isSplitParentWorktree,
    log: cleanupLog,
  };

  // Reattach step: re-couple a session-less worktree to a fresh session on the
  // existing worktree (resuming its prior conversation) instead of reaping it, so a
  // session that died while its PR is still open comes back with its work intact.
  // Shares the cleanup step's codebase handle and merged/closed PR sources (a
  // resolved worktree is cleanup's to tear down) and is gated on it. Runs AFTER
  // cleanup in the heartbeat — see the heartbeat below.
  const reattachLog = (msg: string) => console.log(`[reattach] ${msg}`);
  const sweepDeps: OrphanSweepDeps | null = cleanup && {
    listWorktrees: () => listGitWorktrees(cleanup.codebasePath),
    listSessions: listTmuxSessions,
    worktreesDir,
    resolvedBranches: async () => {
      const [merged, closed] = await Promise.all([
        cleanup.listMergedPRs(),
        cleanup.listClosedUnmergedPRs(),
      ]);
      return new Set([...merged, ...closed].map((p) => p.headRefName));
    },
    readParentSession,
    hasSessionFor: hasSessionForWorktree,
    isLaunching: (path) => launchMarkerActive(path, LAUNCH_MARKER_TTL_MS),
    ageMs: worktreeAgeMs,
    minAgeMs: config.heartbeatIntervalMinutes * 60 * 1000,
    reattach: reattachSession,
    log: reattachLog,
  };

  // Advance step (gh-driven): each heartbeat, judge merged PRs' issues against
  // their AC tracker and spawn a continuation while criteria remain open.
  const advanceLog = (msg: string) => console.log(`[advance] ${msg}`);
  const advanceState = freshAdvanceState();
  const advanceDeps: AdvanceDeps | null = config.advance && {
    ...config.advance,
    spawnContinuation: (issueNumber, round) => {
      const { key, label } = deriveKey({ branch: `eng-${issueNumber}` });
      emitEvent({ kind: "task_started", key, label });
      spawnContinuationSession(issueNumber, round);
    },
    markReady: (identifier: string) => {
      const match = findExistingSession(identifier, listTmuxSessions(), listWorktreeDirs());
      if (match) setFeatureReady(match);
    },
    log: advanceLog,
  };

  // Ready step (gh-driven): each heartbeat, keep the ready-to-merge label in sync
  // on each non-draft open PR. Independent of the fixers, which keep running on
  // every open PR, so a labeled PR that regresses is still fixed and just loses the
  // label until it is clean again.
  const readyLog = (msg: string) => console.log(`[ready] ${msg}`);
  // Rebuilt from scratch by listOpenPRs each tick, before addLabel/removeLabel
  // run (see readyOnce), so the wraps below can key events by branch like every
  // other step instead of by PR number, letting them unify with the ticket's
  // row. Cleared each tick so closed/merged PRs do not accumulate forever.
  const prBranchByNumber = new Map<number, string>();
  const readyDeps: PrReadyDeps | null = config.ready && {
    ...config.ready,
    listOpenPRs: async () => {
      const prs = await config.ready!.listOpenPRs();
      prBranchByNumber.clear();
      for (const pr of prs) prBranchByNumber.set(pr.number, pr.headRefName);
      return prs;
    },
    // Board emission is owned by onVerdict below (fires whether or not a label
    // write happens), so a PR that is ready but already carries the label still
    // shows ready-to-merge, and a queued PR held with the label reconciles off a
    // stale fix status. The label writers stay pure GitHub side effects.
    onVerdict: (n: number, verdict, hasLabel) => {
      if (!boardReadyToMerge(verdict, hasLabel)) return;
      const branch = prBranchByNumber.get(n);
      const k = branch ? deriveKey({ branch }) : deriveKey({ pr: n });
      emitStatus({ kind: "ready_to_merge", key: k.key, label: k.label, pr: n });
    },
    addLabel: (n: number, label: string) => config.ready!.addLabel(n, label),
    removeLabel: (n: number, label: string) => {
      const branch = prBranchByNumber.get(n);
      const k = branch ? deriveKey({ branch }) : deriveKey({ pr: n });
      emitStatus({ kind: "ready_regressed", key: k.key, label: k.label, pr: n });
      return config.ready!.removeLabel(n, label);
    },
    log: readyLog,
  };

  // Claim step: on each heartbeat, while below the WIP cap, move the top
  // current-cycle Todo into "In Progress" so the deploy step launches it.
  const claimLog = (msg: string) => console.log(`[claim] ${msg}`);
  const claimState = freshClaimState();
  const { claim } = config;
  const viewerId = config.progressContext.viewerId;
  const fetchMergedIdentifiers = config.blocked
    ? async () => mergedIdentifierSet(await config.blocked!.listMergedPRs())
    : undefined;
  const dependencyScanDeps: DependencyScanDeps | null = config.dependencyScan && {
    fetchMarker: (issueId) => fetchMarkedCommentBody(config.apiKey, issueId, DEPENDENCY_COMMENT_MARKER),
    scan: config.dependencyScan.scan,
    resolveId: async (identifier) => (await fetchIssueByIdentifier(config.apiKey, identifier)).id,
    createRelation: (blockerId, blockedId) => createBlocksRelation(config.apiKey, blockerId, blockedId),
    writeMarker: (issueId, body) =>
      upsertMarkedComment(config.apiKey, issueId, DEPENDENCY_COMMENT_MARKER, body),
  };
  const claimDeps: ClaimDeps = {
    autoClaim: claim.autoClaim,
    riskLabels: claim.riskLabels,
    labelFilter: claim.labelFilter,
    maxInProgress: claim.maxInProgress,
    countInProgress: () =>
      countAssignedInState(config.apiKey, viewerId, claim.progressStateName, claim.labelFilter),
    fetchCycleTodos: () => fetchCycleTodoIssues(config.apiKey, claim.todoContext),
    fetchMergedIdentifiers,
    moveToInProgress: async (issue) => {
      await moveIssueToState(config.apiKey, issue.id, config.progressContext.stateId);
      const { key, label } = deriveKey({ identifier: issue.identifier });
      emitEvent({ kind: "task_started", key, label, title: issue.title });
      if (config.advance) {
        try {
          const detail = await fetchIssueByIdentifier(config.apiKey, issue.identifier);
          // Seed once: a re-claim must not clobber a tracker that already has
          // satisfied/skipped ACs, so no-op when one is present.
          const existing = await fetchMarkedCommentBody(config.apiKey, detail.id, AC_COMMENT_MARKER);
          if (existing) return;
          const acs = parseAcceptanceCriteria(detail.description);
          if (acs.length > 0) {
            await upsertMarkedComment(config.apiKey, detail.id, AC_COMMENT_MARKER, renderAcComment(acs));
          }
        } catch (err) {
          claimLog(`AC seed failed for ${issue.identifier}: ${err}`);
        }
      }
    },
    dependencyScan: dependencyScanDeps,
    log: claimLog,
  };

  // Reconcile step: on each heartbeat, move any In-Progress ticket whose blocker
  // has no merged PR back to Todo and clear the deploy latch, so it is out of the
  // In-Progress set before deploy runs and a later re-claim relaunches it once
  // unblocked. It never tears the worktree/session down — a worktree lives until
  // its PR resolves.
  const reconcileLog = (msg: string) => console.log(`[reconcile] ${msg}`);
  const reconcileDeps: ReconcileDeps | null = config.blocked && {
    fetchInProgress: async () =>
      filterByLabel(
        config.labelFilter,
        await fetchInProgressIssuesWithBlockers(config.apiKey, config.progressContext),
      ),
    fetchMergedIdentifiers: async () => mergedIdentifierSet(await config.blocked!.listMergedPRs()),
    moveToTodo: (issueId) => moveIssueToState(config.apiKey, issueId, config.claim.todoContext.stateId),
    unlatchDeploy: (issueId) => void deployState.launched.delete(issueId),
    log: reconcileLog,
  };

  let running = false;
  const heartbeat = async () => {
    if (running) return;
    running = true;
    try {
      if (reconcileDeps) await reconcileBlockedInProgress(reconcileDeps);
      await deployOnce(deployState, deployDeps);
      await pollOnce(reviewIconState, reviewIconDeps);
      if (prReviewDeps) await reviewOnce(reviewState, prReviewDeps);
      if (cleanupDeps) await cleanupOnce(cleanupDeps);
      // The reattach step MUST run after cleanup: cleanup tears down resolved
      // (merged/closed) worktrees, and reattach re-couples the rest. Running it
      // last means its own merged/closed fetch sees any PR that resolved this tick
      // and skips that worktree, so reattach never spawns a session on a worktree
      // cleanup is concurrently tearing down. (deploy adopts a re-coupled worktree
      // on the next tick regardless of order — it matches on the worktree dir,
      // which reattach reuses rather than creates.)
      if (sweepDeps) await sweepOrphanWorktrees(sweepDeps);
      if (advanceDeps) await advanceOnce(advanceState, advanceDeps);
      if (readyDeps) await readyOnce(readyDeps);
      // The claim step MUST run last: the deploy poll fetches first, so a ticket
      // the claim step moves to In Progress this tick is launched on the NEXT
      // tick (not double-launched now), and the higher In-Progress count keeps
      // the WIP cap accounting correct.
      await claimOnce(claimState, claimDeps);
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
