// src/stuck-sessions.ts
// A task row says "working" until some event changes it, and nothing fires when
// its Claude session dies or goes quiet. Each heartbeat this step compares every
// working row's known panes with tmux and emits session_stuck / session_resumed
// so the board shows what is really happening. When Claude exited but its pane
// survives as a shell, it also types `claude --continue` back into that pane.
import { STUCK_STATUS, isWorkingStatus, rowKeyOf, type BoardRow, type YimbotEvent } from "./events.ts";

export const MAX_RESUME_ATTEMPTS = 3;

const CLAUDE_COMMANDS = new Set(["claude", "node"]);
export const SHELL_COMMANDS = new Set(["bash", "zsh", "fish", "sh", "dash"]);

export function stuckIdleMs(raw: string | undefined): number {
  const minutes = Number(raw);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 30 * 60_000;
}

export type PaneInfo = { cmd: string; activityMs: number };

export type StuckDeps = {
  events: () => YimbotEvent[];
  rows: () => BoardRow[];
  // null when tmux is unreachable: every pane would look gone, so do nothing.
  panes: () => Map<string, PaneInfo> | null;
  hasSessionFor: (key: string) => boolean;
  now: () => number;
  idleMs: number;
  emit: (e: { kind: "session_stuck" | "session_resumed"; key: string; label: string; reason?: string }) => void;
  resume: (pane: string) => void;
  log: (msg: string) => void;
};

export type StuckState = { resumeAttempts: Map<string, number> };

export function freshStuckState(): StuckState {
  return { resumeAttempts: new Map() };
}

function knownPanes(events: YimbotEvent[]): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const e of events) {
    if (!e.pane) continue;
    const list = byKey.get(rowKeyOf(e)) ?? [];
    if (!list.includes(e.pane)) list.push(e.pane);
    byKey.set(rowKeyOf(e), list);
  }
  return byKey;
}

type Verdict = { reason: string; resumePane?: string };

function judge(
  key: string,
  panes: string[],
  live: Map<string, PaneInfo>,
  deps: StuckDeps,
): Verdict | null {
  const alive = panes.filter((p) => live.has(p));
  const shell = alive.find((p) => SHELL_COMMANDS.has(live.get(p)!.cmd));
  if (shell) return { reason: "claude exited", resumePane: shell };
  if (alive.length === 0) return deps.hasSessionFor(key) ? null : { reason: "session ended" };
  const claude = alive.filter((p) => CLAUDE_COMMANDS.has(live.get(p)!.cmd));
  if (claude.length === 0) return null;
  const lastActivity = Math.max(...claude.map((p) => live.get(p)!.activityMs));
  const quietMs = deps.now() - lastActivity;
  if (quietMs <= deps.idleMs) return null;
  return { reason: `no activity ${Math.round(quietMs / 60_000)}m` };
}

// "no activity 31m" and "no activity 45m" are the same stuck state.
const sameReason = (a: string, b: string) => a.replace(/\d+m$/, "") === b.replace(/\d+m$/, "");

export function detectStuckSessions(state: StuckState, deps: StuckDeps): void {
  const live = deps.panes();
  if (live === null) return;
  const panesByKey = knownPanes(deps.events());
  for (const row of deps.rows()) {
    const currentlyStuck = row.status === STUCK_STATUS;
    if (row.terminal || !(currentlyStuck || isWorkingStatus(row.status))) continue;
    const verdict = judge(row.key, panesByKey.get(row.key) ?? [], live, deps);
    if (!verdict) {
      if (currentlyStuck) {
        deps.emit({ kind: "session_resumed", key: row.key, label: row.label });
        state.resumeAttempts.delete(row.key);
        deps.log(`${row.key} session is healthy again`);
      }
      continue;
    }
    if (!currentlyStuck || !sameReason(row.stuckReason ?? "", verdict.reason)) {
      deps.emit({ kind: "session_stuck", key: row.key, label: row.label, reason: verdict.reason });
      deps.log(`${row.key} stuck: ${verdict.reason}`);
    }
    if (!verdict.resumePane) continue;
    const attempts = state.resumeAttempts.get(row.key) ?? 0;
    if (attempts >= MAX_RESUME_ATTEMPTS) continue;
    state.resumeAttempts.set(row.key, attempts + 1);
    deps.resume(verdict.resumePane);
    deps.log(`${row.key} resuming claude in ${verdict.resumePane} (attempt ${attempts + 1})`);
  }
}
