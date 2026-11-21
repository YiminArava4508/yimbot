// src/stuck-sessions.ts
// A task row says "working" until some event changes it, and nothing fires when
// its Claude session dies or goes quiet. Each heartbeat this step compares every
// working row's known panes with tmux and emits session_stuck / session_resumed
// so the board shows what is really happening. When Claude exited but its pane
// survives as a shell, it also types `claude --continue` back into that pane.
// When Claude is alive but has sat at its prompt past the idle limit (it ended
// its turn waiting for a "continue" no one will type, e.g. after a transient
// disk-full or network error), it types IDLE_NUDGE_PROMPT into that pane, if
// canNudge allows (autonomous mode, disk not low).
import { STUCK_STATUS, isWorkingStatus, rowKeyOf, type BoardRow, type YimbotEvent } from "./events.ts";

export const MAX_RESUME_ATTEMPTS = 3;
const RESUME_WINDOW_MS = 60 * 60_000;

export const IDLE_NUDGE_PROMPT =
  "You have been idle at your prompt with no activity, and no human is available to answer. " +
  "If you stopped because of a transient failure (disk full / ENOSPC, network, rate limit, a flaky " +
  "command), retry it now. If you stopped to ask something, make the call yourself as a staff " +
  "engineer, state it in one line, and continue the task. If the task is genuinely finished, say so " +
  "in one line and stop.";

export const SHELL_COMMANDS = new Set(["bash", "zsh", "fish", "sh", "dash"]);

// Claude Code ships as a native binary named after its version, so tmux
// reports e.g. "2.1.327" as the pane's foreground command.
export function isClaudeCommand(cmd: string): boolean {
  return cmd === "claude" || cmd === "node" || /^\d+\.\d+\.\d+$/.test(cmd);
}

export function stuckIdleMs(raw: string | undefined): number {
  const minutes = Number(raw);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 30 * 60_000;
}

export type PaneInfo = { cmd: string; activityMs: number; session: string };

export type StuckDeps = {
  events: () => YimbotEvent[];
  rows: () => BoardRow[];
  // null when tmux is unreachable: every pane would look gone, so do nothing.
  panes: () => Map<string, PaneInfo> | null;
  hasSessionFor: (key: string) => boolean;
  // Whether a tmux session name belongs to the ticket behind this row key.
  ownsSession: (session: string, key: string) => boolean;
  now: () => number;
  idleMs: number;
  emit: (e: { kind: "session_stuck" | "session_resumed"; key: string; label: string; reason?: string }) => void;
  resume: (pane: string) => void;
  // Whether an idle live Claude may be prompted right now. False (outside
  // autonomous mode, or while disk is low and a retry would just fail again)
  // leaves the row stuck without spending a resume attempt.
  canNudge: () => boolean;
  // Type IDLE_NUDGE_PROMPT into a live Claude pane. False when nothing was sent.
  nudge: (pane: string, prompt: string) => boolean;
  log: (msg: string) => void;
};

// Resume attempt times per key. Not refunded when a session looks healthy again,
// so a Claude that crashes minutes after each relaunch still hits the cap.
export type StuckState = { resumeAttempts: Map<string, number[]> };

export function freshStuckState(): StuckState {
  return { resumeAttempts: new Map() };
}

type LastPane = { pane: string; ended: boolean };

// The newest pane each row's events came from, and whether that pane's last
// word was a SessionEnd (a deliberate exit rather than a crash).
function lastPanes(events: YimbotEvent[]): Map<string, LastPane> {
  const byKey = new Map<string, LastPane>();
  for (const e of events) {
    if (!e.pane) continue;
    const key = rowKeyOf(e);
    const prev = byKey.get(key);
    const ended = e.kind === "session_ended";
    byKey.set(key, { pane: e.pane, ended: prev?.pane === e.pane && !ended ? false : ended });
  }
  return byKey;
}

// resumePane: Claude exited, relaunch it there. nudgePane: Claude is alive but
// idle, prompt it there.
type Verdict = { reason: string; resumePane?: string; nudgePane?: string };

function judge(key: string, last: LastPane | undefined, live: Map<string, PaneInfo>, deps: StuckDeps): Verdict | null {
  const gone = (): Verdict | null => (deps.hasSessionFor(key) ? null : { reason: "session ended" });
  const info = last && live.get(last.pane);
  if (!last || !info) return gone();
  if (!deps.ownsSession(info.session, key)) return gone();
  const sameSession = [...live.entries()].filter(([, p]) => p.session === info.session);
  const claudePanes = sameSession.filter(([, p]) => isClaudeCommand(p.cmd));
  if (SHELL_COMMANDS.has(info.cmd)) {
    if (claudePanes.length > 0) return null;
    return { reason: "claude exited", resumePane: last.ended ? undefined : last.pane };
  }
  if (claudePanes.length === 0) return null;
  const quietMs = deps.now() - Math.max(...claudePanes.map(([, p]) => p.activityMs));
  if (quietMs <= deps.idleMs) return null;
  // Prompt the row's own pane when it is the Claude; otherwise (its last event
  // came from a sibling window running something else, e.g. an editor) the most
  // recently active Claude in the same session.
  const nudgePane = isClaudeCommand(info.cmd)
    ? last.pane
    : claudePanes.reduce((a, b) => (b[1].activityMs > a[1].activityMs ? b : a))[0];
  return { reason: `no activity ${Math.round(quietMs / 60_000)}m`, nudgePane };
}

// "no activity 31m" and "no activity 45m" are the same stuck state.
const sameReason = (a: string, b: string) => a.replace(/\d+m$/, "") === b.replace(/\d+m$/, "");

export function detectStuckSessions(state: StuckState, deps: StuckDeps): void {
  const live = deps.panes();
  if (live === null) return;
  const lastByKey = lastPanes(deps.events());
  for (const row of deps.rows()) {
    const currentlyStuck = row.status === STUCK_STATUS;
    if (row.terminal || !(currentlyStuck || isWorkingStatus(row.status))) continue;
    const verdict = judge(row.key, lastByKey.get(row.key), live, deps);
    if (!verdict) {
      if (currentlyStuck) {
        deps.emit({ kind: "session_resumed", key: row.key, label: row.label });
        deps.log(`${row.key} session is healthy again`);
      }
      continue;
    }
    if (!currentlyStuck || !sameReason(row.stuckReason ?? "", verdict.reason)) {
      deps.emit({ kind: "session_stuck", key: row.key, label: row.label, reason: verdict.reason });
      deps.log(`${row.key} stuck: ${verdict.reason}`);
    }
    const nudgePane = verdict.nudgePane && deps.canNudge() ? verdict.nudgePane : undefined;
    if (!verdict.resumePane && !nudgePane) continue;
    const now = deps.now();
    const recent = (state.resumeAttempts.get(row.key) ?? []).filter((t) => now - t < RESUME_WINDOW_MS);
    if (recent.length >= MAX_RESUME_ATTEMPTS) {
      state.resumeAttempts.set(row.key, recent);
      continue;
    }
    // One budget for relaunches and idle nudges: a session that keeps dying or
    // keeps going quiet hits the same cap and stays stuck for a person.
    state.resumeAttempts.set(row.key, [...recent, now]);
    if (verdict.resumePane) {
      deps.resume(verdict.resumePane);
      deps.log(`${row.key} resuming claude in ${verdict.resumePane} (attempt ${recent.length + 1})`);
    } else if (nudgePane && deps.nudge(nudgePane, IDLE_NUDGE_PROMPT)) {
      deps.log(`${row.key} nudged idle claude in ${nudgePane} (attempt ${recent.length + 1})`);
    } else {
      deps.log(`${row.key} idle nudge not delivered to ${nudgePane} (attempt ${recent.length + 1})`);
    }
  }
}
