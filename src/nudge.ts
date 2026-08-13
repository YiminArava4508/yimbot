// src/nudge.ts
// Autonomous-mode unsticking: when a session reports needs_input and no human
// is meant to answer, send it a prompt to resolve the block itself. The
// session's own UserPromptSubmit hook then emits input_received, clearing the
// attention state. A session that keeps coming back gets flagged "stuck"
// instead of nudged forever.
import { foldAttention, type YimbotEvent } from "./events.ts";
import type { Mode } from "./mode.ts";

export const NUDGE_PROMPT =
  "You are running unattended. Act as a staff software engineer: think in terms of systems, " +
  "scaling, and long-term maintainability. Whatever is blocking you (a question, a review " +
  "comment, a permission that was declined), do not accept claims at face value: verify each " +
  "claim against the code and evidence first, reject what does not hold up with a brief " +
  "justification, and act on what does. Make the decision yourself and continue; no human is available.";

export type NudgeDeps = {
  mode: () => Mode;
  events: () => YimbotEvent[];
  // Deliver the prompt into a tmux pane. Returns false when the pane is gone
  // or no longer runs Claude (the key gets flagged instead); throws on other
  // tmux failures (logged, retried next tick).
  send: (pane: string, prompt: string) => boolean;
  raiseFlag: (key: string, label: string, reason: string) => void;
  log: (msg: string) => void;
  // Lifetime cap per key for this process: past it the key is flagged "stuck".
  maxNudges: number;
};

// nudgedAt records the needs_input timestamp last acted on per key, so one
// raise gets one nudge no matter how many ticks it stays pending. counts is
// the per-key lifetime total against maxNudges. In-memory: a daemon restart
// grants a fresh allowance.
export type NudgeState = { nudgedAt: Map<string, number>; counts: Map<string, number> };

export function freshNudgeState(): NudgeState {
  return { nudgedAt: new Map(), counts: new Map() };
}

export function nudgeOnce(state: NudgeState, deps: NudgeDeps): void {
  if (deps.mode() !== "autonomous") return;
  const events = deps.events();
  const att = foldAttention(events);
  const latest = new Map<string, YimbotEvent>();
  for (const e of events) if (e.kind === "needs_input") latest.set(e.key, e);

  for (const [key, e] of latest) {
    if (!att.get(key)?.reasons.has("input")) continue; // already answered
    if (state.nudgedAt.get(key) === e.ts) continue; // this raise was handled
    const count = state.counts.get(key) ?? 0;
    // Out of allowance, or nothing to aim at (event from an older hook build
    // carries no pane): a person has to look.
    if (count >= deps.maxNudges || !e.pane) {
      deps.raiseFlag(key, e.label, "stuck");
      state.nudgedAt.set(key, e.ts);
      continue;
    }
    try {
      if (deps.send(e.pane, NUDGE_PROMPT)) {
        state.counts.set(key, count + 1);
        state.nudgedAt.set(key, e.ts);
        deps.log(`nudged ${key} in pane ${e.pane} (${count + 1}/${deps.maxNudges})`);
      } else {
        // The pane is gone or belongs to something else now (crashed session,
        // tmux restart recycling ids): a person has to look.
        deps.raiseFlag(key, e.label, "stuck");
        state.nudgedAt.set(key, e.ts);
      }
    } catch (err) {
      deps.log(`nudge failed for ${key} in pane ${e.pane}: ${err}`);
    }
  }
}
