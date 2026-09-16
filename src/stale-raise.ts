// src/stale-raise.ts
// A raise (needs_input, decision, findings) is only cleared by the session that
// made it, via its UserPromptSubmit hook, or by a person pressing f. When that
// session is reaped or killed first, the flag outlives it and the board keeps
// asking for input nobody can give. Each heartbeat this step checks the raising
// pane(s) of every pending hook raise against the live pane list and drops the
// reason once all of them are gone. Only a missing pane counts: a pane whose
// foreground is momentarily a shell (an operator relaunching Claude) keeps its
// flag. Daemon-side reasons (changes-requested, human-comment, stuck) have no
// pane and are never touched here.
import { foldAttention, type YimbotEvent } from "./events.ts";

export type StaleRaiseDeps = {
  events: () => YimbotEvent[];
  // Every pane id the tmux server currently has, or null when the server is
  // unreachable: then every pane would look gone and the step must not wipe
  // the board.
  livePanes: () => Set<string> | null;
  clear: (key: string, label: string, reason: string) => void;
  log: (msg: string) => void;
};

export function clearDeadRaises(deps: StaleRaiseDeps): void {
  const live = deps.livePanes();
  if (live === null) return;
  const events = deps.events();
  const labels = new Map<string, string>();
  for (const e of events) labels.set(e.key, e.label);
  for (const [key, a] of foldAttention(events)) {
    for (const [reason, panes] of a.panes) {
      if ([...panes].some((p) => live.has(p))) continue;
      deps.clear(key, labels.get(key) ?? key, reason);
      deps.log(`cleared ${key} ${reason}: raising pane ${[...panes].join(",")} is gone`);
    }
  }
}
