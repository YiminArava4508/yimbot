import { execFileSync, spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  countAssignedInState,
  type CycleTodoIssue,
  fetchCycleTodoIssues,
  fetchTriggerIssues,
  type LinearContext,
  type LinearIssue,
  moveIssueToState,
} from "./linear-api.ts";
import { selectNextTicket } from "./picker.ts";

export const sessionScriptPath = join(homedir(), "new-session.sh");
export const runLocalEnvScriptPath = join(homedir(), "run-local-env.sh");
export const worktreesDir = join(homedir(), "Work/worktrees");

export type WatchState = {
  seen: Set<string>;
  initialized: boolean;
};

export type WatcherDeps = {
  fetchIssues: () => Promise<LinearIssue[]>;
  // Handle one newly-appeared issue. `name` is the buildSessionName slug (used
  // by the launch action); `issue` is passed for actions that need the raw
  // identifier (e.g. the resume action's prefix match).
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

export type ResumeDeps = {
  listSessions: () => string[];
  listWorktrees: () => string[];
  resume: (name: string) => Promise<void> | void;
  log: (msg: string) => void;
};

// Action for the In-Review trigger: bring up the dev env for an issue's
// existing session/worktree. Never creates a worktree — if none exists it logs
// and returns (so the poll marks it seen and won't retry). Resume errors
// propagate so the poll leaves the issue unseen and retries next tick.
export async function resumeExistingEnv(issue: LinearIssue, deps: ResumeDeps): Promise<void> {
  const match = findExistingSession(issue.identifier, deps.listSessions(), deps.listWorktrees());
  if (!match) {
    deps.log(`no existing session/worktree for ${issue.identifier}, skipping resume`);
    return;
  }
  await deps.resume(match);
  deps.log(`resumed dev env for ${issue.identifier} (${match})`);
}

export function detectNewIssues(state: WatchState, issues: LinearIssue[]): LinearIssue[] {
  if (!state.initialized) {
    // Issues already in the trigger state at startup are the baseline;
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
      // (Success logging is the action's responsibility — it varies per trigger.)
      state.seen.add(issue.id);
    } catch (err) {
      deps.log(`failed to handle ${issue.identifier}: ${err}`);
    }
  }
}

export type PickDeps = {
  // Whether autonomous picking is enabled at all.
  autoPick: boolean;
  // Max concurrent In-Review tickets before the pipeline stalls.
  maxReview: number;
  // Label names that disqualify a ticket from being auto-picked.
  riskLabels: string[];
  // Viewer-wide counts (across all teams) of the personal WIP states.
  countInProgress: () => Promise<number>;
  countInReview: () => Promise<number>;
  // The watched team's active-cycle Todo issues assigned to the viewer.
  fetchCycleTodos: () => Promise<CycleTodoIssue[]>;
  // Move the chosen ticket into the watched "In Progress" state, so the
  // existing launch trigger picks it up on the next poll.
  moveToInProgress: (issue: CycleTodoIssue) => Promise<void>;
  log: (msg: string) => void;
};

// One autonomous-picker tick. Gated by WIP limits: acts only when nothing is
// In Progress (one at a time) and the review queue has room; otherwise it does
// nothing (logging a stall when the review cap is the blocker). When the gate
// is open it selects the top eligible current-cycle Todo and moves it to In
// Progress — it never launches anything itself.
//
// Known limitation: launching relies on trigger 1 detecting the Todo→In
// Progress transition, and that trigger only fires once per issue per daemon
// lifetime (its seen-set is never cleared). So if a human moves an
// already-launched ticket back to Todo, the picker can re-pick it and move it
// to In Progress but trigger 1 will ignore it — it stays In Progress with no
// session and stalls the picker until a human intervenes. This only happens on
// a manual backward move; the normal forward flow is unaffected.
export async function pickOnce(deps: PickDeps): Promise<void> {
  if (!deps.autoPick) return;

  let inReview: number;
  try {
    if ((await deps.countInProgress()) > 0) return; // busy — one ticket at a time
    inReview = await deps.countInReview();
  } catch (err) {
    deps.log(`pick failed: ${err}`);
    return;
  }
  if (inReview >= deps.maxReview) {
    deps.log(`review full (${inReview}/${deps.maxReview}) — pipeline stalled`);
    return;
  }

  let todos: CycleTodoIssue[];
  try {
    todos = await deps.fetchCycleTodos();
  } catch (err) {
    deps.log(`pick failed: ${err}`);
    return;
  }

  const next = selectNextTicket(todos, { riskLabels: deps.riskLabels });
  if (!next) return;

  try {
    await deps.moveToInProgress(next);
    deps.log(`picked ${next.identifier} → In Progress`);
  } catch (err) {
    deps.log(`failed to move ${next.identifier}: ${err}`);
  }
}

export type PickerConfig = {
  autoPick: boolean;
  maxReview: number;
  riskLabels: string[];
  // Watched-team Todo context (team + Todo state + viewer) for cycle queries.
  todoContext: LinearContext;
  // State names for the viewer-wide, team-agnostic WIP counts.
  progressStateName: string;
  reviewStateName: string;
};

export type WatcherConfig = {
  apiKey: string;
  progressContext: LinearContext;
  reviewContext: LinearContext;
  pollIntervalMinutes: number;
  picker: PickerConfig;
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

// Spin up the dev env for an already-existing worktree/session by handing its
// name to ~/run-local-env.sh (which no-ops if the env is already up). Detached,
// like launchSession; rejects on spawn error so the poll can retry.
export function resumeSession(name: string): Promise<void> {
  const proc = spawn("bash", [runLocalEnvScriptPath, name], { detached: true, stdio: "ignore" });
  proc.unref();
  const result = new Promise<void>((resolve, reject) => {
    proc.once("spawn", () => resolve());
    proc.once("error", (err) => reject(err));
  });
  proc.once("exit", (code) => {
    if (code !== 0) console.error(`[watcher] run-local-env.sh for '${name}' exited ${code}`);
  });
  return result;
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

export function startWatcher(config: WatcherConfig): () => void {
  const log = (msg: string) => console.log(`[watcher] ${msg}`);

  // Trigger 1: issues entering "In Progress" → create a worktree + session.
  const progressState: WatchState = { seen: new Set(), initialized: false };
  const progressDeps: WatcherDeps = {
    fetchIssues: () => fetchTriggerIssues(config.apiKey, config.progressContext),
    launch: async (name, issue) => {
      await launchSession(name);
      log(`launched session '${name}' for ${issue.identifier}`);
    },
    log,
  };

  // Trigger 2: issues entering "In Review" → resume the existing env only.
  const reviewState: WatchState = { seen: new Set(), initialized: false };
  const reviewDeps: WatcherDeps = {
    fetchIssues: () => fetchTriggerIssues(config.apiKey, config.reviewContext),
    launch: (_name, issue) =>
      resumeExistingEnv(issue, {
        listSessions: listTmuxSessions,
        listWorktrees: listWorktreeDirs,
        resume: resumeSession,
        log,
      }),
    log,
  };

  // Autonomous picker: on each poll, when idle and the review queue has room,
  // move the top current-cycle Todo into "In Progress" so trigger 1 launches it.
  const pickerLog = (msg: string) => console.log(`[picker] ${msg}`);
  const { picker } = config;
  const viewerId = config.progressContext.viewerId;
  const pickDeps: PickDeps = {
    autoPick: picker.autoPick,
    maxReview: picker.maxReview,
    riskLabels: picker.riskLabels,
    countInProgress: () => countAssignedInState(config.apiKey, viewerId, picker.progressStateName),
    countInReview: () => countAssignedInState(config.apiKey, viewerId, picker.reviewStateName),
    fetchCycleTodos: () => fetchCycleTodoIssues(config.apiKey, picker.todoContext),
    moveToInProgress: (issue) =>
      moveIssueToState(config.apiKey, issue.id, config.progressContext.stateId),
    log: pickerLog,
  };

  let running = false;
  const poll = async () => {
    if (running) return;
    running = true;
    try {
      await pollOnce(progressState, progressDeps);
      await pollOnce(reviewState, reviewDeps);
      // The picker MUST run last: the triggers fetch first, so a ticket the
      // picker moves to In Progress this tick is launched on the NEXT tick (not
      // double-launched now), and the one-in-progress gate blocks re-picking it.
      await pickOnce(pickDeps);
    } finally {
      running = false;
    }
  };

  const safePoll = () => void poll().catch((err) => console.error(`[watcher] poll crashed: ${err}`));

  safePoll();
  const timer = setInterval(safePoll, config.pollIntervalMinutes * 60 * 1000);
  return () => clearInterval(timer);
}
