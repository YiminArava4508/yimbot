import { EventEmitter } from "node:events";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envOr } from "./env.ts";

export type EventKind =
  | "task_started"
  | "review_started"
  | "ci_fix_started"
  | "conflict_fix_started"
  | "blocked_fix_started"
  | "ready_to_test"
  | "ready_to_merge"
  | "ready_regressed"
  | "merged";

export type YimbotEvent = {
  ts: number;
  kind: EventKind;
  key: string;
  label: string;
  title?: string;
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

const STATUS: Record<EventKind, { status: string; terminal: boolean }> = {
  task_started: { status: "working", terminal: false },
  review_started: { status: "addressing review", terminal: false },
  ci_fix_started: { status: "fixing CI", terminal: false },
  conflict_fix_started: { status: "resolving conflict", terminal: false },
  blocked_fix_started: { status: "unblocking", terminal: false },
  ready_to_test: { status: "ready to test", terminal: false },
  ready_to_merge: { status: "ready to merge", terminal: false },
  ready_regressed: { status: "working", terminal: false },
  merged: { status: "merged", terminal: true },
};

export function statusFor(kind: EventKind): { status: string; terminal: boolean } {
  return STATUS[kind];
}

export const bus = new EventEmitter();
bus.setMaxListeners(0);

export function eventsLogPath(): string {
  return envOr("EVENTS_LOG", join(process.cwd(), "events.jsonl"));
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
  status: string;
  terminal: boolean;
  ts: number;
};

function keepMergedMsDefault(): number {
  const n = Number(envOr("TUI_KEEP_MERGED_MS", "300000"));
  return Number.isFinite(n) && n >= 0 ? n : 300000;
}

function maxRowsDefault(): number {
  const n = Number(envOr("TUI_MAX_ROWS", "100"));
  return Number.isInteger(n) && n > 0 ? n : 100;
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
    const { status, terminal } = statusFor(e.kind);
    const prev = byKey.get(e.key);
    byKey.set(e.key, {
      key: e.key,
      label: e.label,
      title: e.title ?? prev?.title,
      status,
      terminal,
      ts: e.ts,
    });
  }

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
