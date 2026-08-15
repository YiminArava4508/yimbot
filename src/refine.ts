import { labelFilterAllows, type LabelFilter } from "./labels.ts";

export type RefineIssue = { id: string; identifier: string; title: string; labels: string[] };

export type RefineDeps = {
  autoRefine: boolean;
  maxRefining: number;
  labelFilter: LabelFilter;
  fetchUnestimated: () => Promise<RefineIssue[]>;
  fetchEstimate: (identifier: string) => Promise<number | null>;
  hasSession: (name: string) => boolean;
  listSessions: () => string[];
  spawn: (identifier: string, title: string) => void;
  kill: (name: string) => void;
  markRefined: (identifier: string, title: string) => void;
  now: () => number;
  reapStaleMs: number;
  log: (msg: string) => void;
};

// In-flight refine sessions by ticket identifier. Per-process: after a daemon
// restart the completion sweep re-adopts every live refine-* session it finds,
// so an orphan is never respawned and always ends up reaped.
export type RefineState = { inFlight: Map<string, { title: string; startedAt: number }> };

export function freshRefineState(): RefineState {
  return { inFlight: new Map() };
}

export function refineSessionName(identifier: string): string {
  return `refine-${identifier.toLowerCase()}`;
}

// One tick of the refine step. Completion sweep first so a finished ticket
// frees its slot for the spawn phase in the same tick. Estimate presence is the
// only completion signal: the session sets one (or creates 0-pointed parents)
// and this step notices, emits, and reaps.
export async function refineOnce(state: RefineState, deps: RefineDeps): Promise<void> {
  if (!deps.autoRefine) return;

  // Adopt live refine sessions this process did not start (a restart, or a
  // ticket that left the unestimated scan) so the sweep below reaps them too.
  for (const name of deps.listSessions()) {
    if (!name.startsWith("refine-")) continue;
    const identifier = name.slice("refine-".length).toUpperCase();
    if (state.inFlight.has(identifier)) continue;
    state.inFlight.set(identifier, { title: "", startedAt: deps.now() });
  }

  for (const [identifier, info] of [...state.inFlight]) {
    const name = refineSessionName(identifier);
    let estimate: number | null;
    try {
      estimate = await deps.fetchEstimate(identifier);
    } catch (err) {
      deps.log(`refine: estimate check failed for ${identifier}: ${err}`);
      continue;
    }
    if (estimate !== null) {
      deps.markRefined(identifier, info.title);
      deps.kill(name);
      state.inFlight.delete(identifier);
      deps.log(`refined ${identifier} (estimate ${estimate})`);
      continue;
    }
    if (!deps.hasSession(name)) {
      state.inFlight.delete(identifier);
      deps.log(`refine: session for ${identifier} died without an estimate; will retry`);
      continue;
    }
    if (deps.now() - info.startedAt > deps.reapStaleMs) {
      deps.kill(name);
      state.inFlight.delete(identifier);
      deps.log(`refine: reaped stale session for ${identifier}`);
    }
  }

  if (state.inFlight.size >= deps.maxRefining) return;
  let issues: RefineIssue[];
  try {
    issues = await deps.fetchUnestimated();
  } catch (err) {
    deps.log(`refine failed: ${err}`);
    return;
  }
  for (const issue of issues) {
    if (state.inFlight.size >= deps.maxRefining) return;
    const adopted = state.inFlight.get(issue.identifier);
    if (adopted) {
      // An orphan adopted above has no title; the scan knows it, so the board
      // row and the refined event get a real label.
      if (!adopted.title) adopted.title = issue.title;
      continue;
    }
    if (!labelFilterAllows(deps.labelFilter, issue.labels)) continue;
    if (deps.hasSession(refineSessionName(issue.identifier))) {
      state.inFlight.set(issue.identifier, { title: issue.title, startedAt: deps.now() });
      continue;
    }
    deps.spawn(issue.identifier, issue.title);
    state.inFlight.set(issue.identifier, { title: issue.title, startedAt: deps.now() });
    deps.log(`refining ${issue.identifier}`);
  }
}
