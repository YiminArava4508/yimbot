import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fetchTriggerIssues, type LinearContext, type LinearIssue } from "./linear-api.ts";

export type WatchState = {
  seen: Set<string>;
  initialized: boolean;
};

export type WatcherDeps = {
  fetchIssues: () => Promise<LinearIssue[]>;
  launch: (name: string) => Promise<void> | void;
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
      await deps.launch(name);
      // Mark seen only after a successful launch so failures retry next poll.
      state.seen.add(issue.id);
      deps.log(`launched session '${name}' for ${issue.identifier}`);
    } catch (err) {
      deps.log(`failed to launch session for ${issue.identifier}: ${err}`);
    }
  }
}

export type WatcherConfig = {
  apiKey: string;
  context: LinearContext;
  pollIntervalMinutes: number;
};

export function launchSession(name: string): Promise<void> {
  const script = join(homedir(), "new-session.sh");
  const proc = spawn("bash", [script, name], { detached: true, stdio: "ignore" });
  proc.unref();
  // spawn() reports failures like ENOENT asynchronously via 'error'; wait for
  // the 'spawn' event so callers can treat a failed launch as an error and retry.
  return new Promise((resolve, reject) => {
    proc.once("spawn", () => resolve());
    proc.once("error", (err) => reject(err));
  });
}

export function startWatcher(config: WatcherConfig): () => void {
  const state: WatchState = { seen: new Set(), initialized: false };
  const deps: WatcherDeps = {
    fetchIssues: () => fetchTriggerIssues(config.apiKey, config.context),
    launch: launchSession,
    log: (msg) => console.log(`[watcher] ${msg}`),
  };

  let running = false;
  const poll = async () => {
    if (running) return;
    running = true;
    try {
      await pollOnce(state, deps);
    } finally {
      running = false;
    }
  };

  void poll();
  const timer = setInterval(() => void poll(), config.pollIntervalMinutes * 60 * 1000);
  return () => clearInterval(timer);
}
