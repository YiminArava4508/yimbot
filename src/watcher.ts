import { execFileSync, spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fetchTriggerIssues, type LinearContext, type LinearIssue } from "./linear-api.ts";

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

export type WatcherConfig = {
  apiKey: string;
  progressContext: LinearContext;
  reviewContext: LinearContext;
  pollIntervalMinutes: number;
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

  let running = false;
  const poll = async () => {
    if (running) return;
    running = true;
    try {
      await pollOnce(progressState, progressDeps);
      await pollOnce(reviewState, reviewDeps);
    } finally {
      running = false;
    }
  };

  const safePoll = () => void poll().catch((err) => console.error(`[watcher] poll crashed: ${err}`));

  safePoll();
  const timer = setInterval(safePoll, config.pollIntervalMinutes * 60 * 1000);
  return () => clearInterval(timer);
}
