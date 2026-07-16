import type { LinearIssue } from "./linear-api.ts";

export type WatchState = {
  seen: Set<string>;
  initialized: boolean;
};

export type WatcherDeps = {
  fetchIssues: () => Promise<LinearIssue[]>;
  launch: (name: string) => void;
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
      deps.launch(name);
      // Mark seen only after a successful launch so failures retry next poll.
      state.seen.add(issue.id);
      deps.log(`launched session '${name}' for ${issue.identifier}`);
    } catch (err) {
      deps.log(`failed to launch session for ${issue.identifier}: ${err}`);
    }
  }
}
