import { EventEmitter } from "node:events";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { envOr } from "./env.ts";

export type EventKind =
  | "task_started"
  | "review_started"
  | "ci_fix_started"
  | "conflict_fix_started"
  | "blocked_fix_started"
  | "ready_to_merge"
  | "ready_regressed"
  | "merged"
  | "flagged"
  | "unflagged"
  | "needs_input"
  | "input_received"
  | "needs_decision"
  | "review_findings";

export type YimbotEvent = {
  ts: number;
  kind: EventKind;
  key: string;
  label: string;
  title?: string;
  pr?: number;
};

const TICKET = /^(eng|sc)-(\d+)/i;

export function deriveKey(opts: { identifier?: string; branch?: string; pr?: number }): {
  key: string;
  label: string;
} {
  if (opts.identifier) {
    const key = opts.identifier.toUpperCase();
    return { key, label: key };
  }
  if (opts.branch) {
    const m = TICKET.exec(opts.branch);
    if (m) {
      const key = `${m[1].toUpperCase()}-${m[2]}`;
      return { key, label: key };
    }
  }
  if (opts.pr != null) return { key: `pr:${opts.pr}`, label: `PR #${opts.pr}` };
  const key = opts.branch ?? "unknown";
  return { key, label: key };
}

export function titleFromBranch(branch: string): string {
  return branch
    .replace(TICKET, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim();
}

// flagged/unflagged/needs_input/input_received have no entry: they are
// attention-timeline signals folded separately in reduceRows, not a status.
// statusFor returns undefined for them.
const STATUS: Partial<Record<EventKind, { status: string; terminal: boolean }>> = {
  task_started: { status: "working", terminal: false },
  review_started: { status: "addressing review", terminal: false },
  ci_fix_started: { status: "fixing CI", terminal: false },
  conflict_fix_started: { status: "resolving conflict", terminal: false },
  blocked_fix_started: { status: "unblocking", terminal: false },
  ready_to_merge: { status: "ready to merge", terminal: false },
  ready_regressed: { status: "working", terminal: false },
  merged: { status: "merged", terminal: true },
  needs_decision: { status: "needs decision", terminal: false },
  review_findings: { status: "review findings", terminal: false },
};

// Takes a plain string, not EventKind: the log persists across versions, so a
// read can surface a kind this build has retired. Returns undefined for any
// kind not in STATUS; callers skip those rather than crash.
export function statusFor(kind: string): { status: string; terminal: boolean } | undefined {
  return STATUS[kind as EventKind];
}

export const bus = new EventEmitter();
bus.setMaxListeners(0);

export function eventsLogPath(): string {
  return envOr("EVENTS_LOG", join(process.cwd(), "events.jsonl"));
}

// Pin an absolute EVENTS_LOG into the environment so child processes (the
// sessions new-session.sh launches, and their Claude hooks) resolve the same
// log file the TUI reads regardless of their own cwd. Returns the pinned path.
export function pinEventsLog(): string {
  const abs = resolve(eventsLogPath());
  process.env.EVENTS_LOG = abs;
  return abs;
}

function maxLines(): number {
  const n = Number(envOr("EVENTS_LOG_MAX_LINES", "500"));
  return Number.isInteger(n) && n > 0 ? n : 500;
}

export function emitEvent(ev: Omit<YimbotEvent, "ts"> & { ts?: number }): void {
  const full: YimbotEvent = { ...ev, ts: ev.ts ?? Date.now() };
  try {
    const path = eventsLogPath();
    appendFileSync(path, JSON.stringify(full) + "\n");
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const cap = maxLines();
    if (lines.length > cap) writeFileSync(path, lines.slice(-cap).join("\n") + "\n");
  } catch {
    // Best-effort telemetry: never crash the daemon on a log IO failure.
  }
  try {
    bus.emit("event", full);
  } catch {
    // A listener throwing must not propagate into the emitter.
  }
}

// Emit an OBSERVED status, deduped against the log: append only when the derived
// status for this key differs from the last one already recorded for it. Steps
// that reconcile against live state every tick use this to reflect what they SEE
// (a PR gone green, a merged worktree) without bloating the log or the board, so
// a row transitions off a stale action status even when no write drove it.
export function emitStatus(ev: Omit<YimbotEvent, "ts"> & { ts?: number }): void {
  let lastKind: EventKind | undefined;
  for (const e of readEvents()) if (e.key === ev.key) lastKind = e.kind;
  const lastStatus = lastKind !== undefined ? statusFor(lastKind)?.status : undefined;
  if (lastStatus !== undefined && lastStatus === statusFor(ev.kind)?.status) return;
  emitEvent(ev);
}

export function readEvents(path: string = eventsLogPath()): YimbotEvent[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: YimbotEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as YimbotEvent);
    } catch {
      // Skip malformed lines (e.g. a torn write).
    }
  }
  return out;
}

export type BoardRow = {
  key: string;
  label: string;
  title?: string;
  pr?: number;
  status: string;
  terminal: boolean;
  ts: number;
  startTs: number;
  flagged: boolean;
};

function keepMergedMsDefault(): number {
  const n = Number(envOr("TUI_KEEP_MERGED_MS", "300000"));
  return Number.isFinite(n) && n >= 0 ? n : 300000;
}

function maxRowsDefault(): number {
  const n = Number(envOr("TUI_MAX_ROWS", "100"));
  return Number.isInteger(n) && n > 0 ? n : 100;
}

export function isFlagged(row: BoardRow): boolean {
  return row.flagged;
}

export function reduceRows(
  events: YimbotEvent[],
  now: number,
  opts: { keepMergedMs?: number; maxRows?: number } = {},
): BoardRow[] {
  const keepMergedMs = opts.keepMergedMs ?? keepMergedMsDefault();
  const maxRows = opts.maxRows ?? maxRowsDefault();

  const byKey = new Map<string, BoardRow>();
  for (const e of events) {
    const mapped = statusFor(e.kind);
    if (!mapped) continue; // flag signals + any kind retired in a newer build
    const prev = byKey.get(e.key);
    const startTs = prev ? (prev.terminal ? e.ts : prev.startTs) : e.ts;
    byKey.set(e.key, {
      key: e.key,
      label: e.label,
      title: e.title ?? prev?.title,
      pr: e.pr ?? prev?.pr,
      status: mapped.status,
      terminal: mapped.terminal,
      ts: e.ts,
      startTs,
      flagged: false,
    });
  }

  // Fold each key's attention timeline into one flag. Walking events in time
  // order, the flag flips on for a needs-input or manual flag and off ONLY for
  // an input-received or a manual unflag. Status events never clear it: the
  // flag strictly means a human must look, so an automated transition (a
  // conflict fix or CI fix spawning) must not swallow a pending ask.
  const flagOn = new Set<EventKind>(["needs_input", "flagged"]);
  const flagged = new Map<string, boolean>();
  for (const e of events) {
    if (flagOn.has(e.kind)) flagged.set(e.key, true);
    else if (e.kind === "input_received" || e.kind === "unflagged") flagged.set(e.key, false);
  }
  for (const row of byKey.values()) row.flagged = flagged.get(row.key) ?? false;

  let rows = [...byKey.values()].filter((r) => !(r.terminal && now - r.ts > keepMergedMs));
  rows.sort((a, b) => b.ts - a.ts);

  while (rows.length > maxRows) {
    if (rows.length === 0) break;
    let idx = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].terminal) {
        idx = i;
        break;
      }
    }
    rows.splice(idx >= 0 ? idx : rows.length - 1, 1);
  }
  return rows;
}

// Keep only rows the live worktrees back: a non-terminal row survives iff a
// worktree exists for its key, so a session/worktree reaped before merge stops
// showing as active. Terminal (merged) rows are kept regardless — their worktree
// is already gone by design, and reduceRows still ages them out past the linger
// window. `liveKeys` is the set of deriveKey() keys of the codebase's worktrees.
export function filterToLiveWorktrees(rows: BoardRow[], liveKeys: Set<string>): BoardRow[] {
  return rows.filter((r) => r.terminal || liveKeys.has(r.key));
}
