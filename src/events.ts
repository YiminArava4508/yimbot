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
  | "draft_pr"
  | "ready_regressed"
  | "awaiting_slices"
  | "merged"
  | "flagged"
  | "unflagged"
  | "needs_input"
  | "input_received"
  | "needs_decision"
  | "review_findings"
  | "refine_started"
  | "refined"
  | "section_tasks"
  | "section_review"
  | "section_merge";

export type YimbotEvent = {
  ts: number;
  kind: EventKind;
  key: string;
  label: string;
  title?: string;
  pr?: number;
  // Why a raise event (needs_input/flagged) raised the flag: input,
  // changes-requested, human-comment, stuck, decision, findings, or manual.
  // Absent on events from older builds; the fold defaults those by kind.
  reason?: string;
  // The tmux pane the emitting hook ran in, so the autonomous-mode nudge can
  // target the exact stuck Claude. Only needs_input events carry it.
  pane?: string;
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

// A ticket-keyed board row can cover several PRs at once: split slices all
// carry the ticket slug, so every slice branch derives to the same key. A single
// merged slice must not mark the whole row merged while sibling PRs are open —
// return only the merged branches whose key no open PR still maps to.
export function branchesFullyMerged(merged: Set<string>, open: Set<string>): string[] {
  const openKeys = new Set([...open].map((b) => deriveKey({ branch: b }).key));
  return [...merged].filter((b) => !openKeys.has(deriveKey({ branch: b }).key));
}

export function titleFromBranch(branch: string): string {
  return branch
    .replace(TICKET, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim();
}

// flagged/unflagged/needs_input/input_received and the section_* kinds have no
// entry: they are attention-timeline and board-placement signals folded
// separately in reduceRows, not a status. statusFor returns undefined for them.
const STATUS: Partial<Record<EventKind, { status: string; terminal: boolean }>> = {
  task_started: { status: "working", terminal: false },
  review_started: { status: "addressing review", terminal: false },
  ci_fix_started: { status: "fixing CI", terminal: false },
  conflict_fix_started: { status: "resolving conflict", terminal: false },
  blocked_fix_started: { status: "unblocking", terminal: false },
  ready_to_merge: { status: "ready to merge", terminal: false },
  draft_pr: { status: "draft pr", terminal: false },
  ready_regressed: { status: "working", terminal: false },
  awaiting_slices: { status: "waiting on slices", terminal: false },
  merged: { status: "merged", terminal: true },
  needs_decision: { status: "needs decision", terminal: false },
  review_findings: { status: "review findings", terminal: false },
  refine_started: { status: "refining", terminal: false },
  refined: { status: "refined", terminal: true },
};

// Takes a plain string, not EventKind: the log persists across versions, so a
// read can surface a kind this build has retired. Returns undefined for any
// kind not in STATUS; callers skip those rather than crash.
export function statusFor(kind: string): { status: string; terminal: boolean } | undefined {
  return STATUS[kind as EventKind];
}

// Which pane a row sits in. Reported by the daemon from live GitHub truth (the
// ready label and the draft flag) rather than derived from status, so a queued
// PR stays put while its status walks through a CI fix, a conflict fix or a
// review round. Only the label coming off moves it.
export type Section = "tasks" | "review" | "merge";

const SECTION: Partial<Record<EventKind, Section>> = {
  section_tasks: "tasks",
  section_review: "review",
  section_merge: "merge",
};

// Tolerant of unknown kinds for the same reason statusFor is: the log outlives
// the build that wrote it.
export function sectionFor(kind: string): Section | undefined {
  return SECTION[kind as EventKind];
}

export function sectionKind(section: Section): EventKind {
  return `section_${section}` as EventKind;
}

const MERGED_STATUS = STATUS.merged!.status;
export const AWAITING_SLICES_STATUS = STATUS.awaiting_slices!.status;

// Statuses that mean a human already owes this row an answer. A status derived
// from somewhere other than the row's own session (the split parent's "waiting
// on slices") must not overwrite one, or the row stops saying what it needs.
const HOLD_STATUSES = new Set([STATUS.needs_decision!.status, STATUS.review_findings!.status]);

export function isHoldStatus(status: string | undefined): boolean {
  return status !== undefined && HOLD_STATUSES.has(status);
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

function parseLine(line: string): YimbotEvent | null {
  try {
    return JSON.parse(line) as YimbotEvent;
  } catch {
    return null; // malformed line (e.g. a torn write)
  }
}

// The standing state a key carries outside its status, of which there are two
// kinds. A "clear" (unflag, input received) is what keeps an already
// acknowledged raise signal down, via emitFlagged's signalTs check, so losing
// it would re-flag a signal a human dismissed. A "section" is the row's pane;
// section events only fire on a change, so a long-lived queued PR's is older
// than its status lines and would be trimmed first, dropping the row into the
// tasks pane until the next heartbeat re-reported it. Returns null for
// everything else.
function standingKind(e: YimbotEvent): string | null {
  if (e.kind === "unflagged" || e.kind === "input_received") return "clear";
  return sectionFor(e.kind) !== undefined ? "section" : null;
}

// Keep the newest dropped event of each standing kind per key, unless the kept
// window already holds a newer one. At most two extra lines per key ride above
// the cap.
function preservedStanding(dropped: string[], kept: string[]): string[] {
  const newest = new Map<string, YimbotEvent>();
  const idOf = (e: YimbotEvent, kind: string) => `${e.key}\u0000${kind}`;
  for (const line of dropped) {
    const e = parseLine(line);
    if (e === null) continue;
    const kind = standingKind(e);
    if (kind === null) continue;
    const cur = newest.get(idOf(e, kind));
    if (!cur || e.ts >= cur.ts) newest.set(idOf(e, kind), e);
  }
  if (newest.size === 0) return [];
  for (const line of kept) {
    const e = parseLine(line);
    if (e === null) continue;
    const kind = standingKind(e);
    if (kind === null) continue;
    const cur = newest.get(idOf(e, kind));
    if (cur && e.ts >= cur.ts) newest.delete(idOf(e, kind));
  }
  return [...newest.values()].sort((a, b) => a.ts - b.ts).map((e) => JSON.stringify(e));
}

export function emitEvent(ev: Omit<YimbotEvent, "ts"> & { ts?: number }): void {
  const full: YimbotEvent = { ...ev, ts: ev.ts ?? Date.now() };
  try {
    const path = eventsLogPath();
    appendFileSync(path, JSON.stringify(full) + "\n");
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const cap = maxLines();
    if (lines.length > cap) {
      const kept = lines.slice(-cap);
      writeFileSync(path, [...preservedStanding(lines.slice(0, -cap), kept), ...kept].join("\n") + "\n");
    }
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
  const lastStatus = currentStatus(ev.key);
  if (lastStatus !== undefined && lastStatus === statusFor(ev.kind)?.status) return;
  emitEvent(ev);
}

// The status a key's row currently shows, or undefined for a key with no
// status-bearing event yet. Only status-bearing kinds count: a flag or section
// event landing after the status must not read back as "no status", which would
// defeat emitStatus's dedupe and re-append the same status every heartbeat.
export function currentStatus(key: string, events: YimbotEvent[] = readEvents()): string | undefined {
  let last: string | undefined;
  for (const e of events) {
    if (e.key !== key) continue;
    const mapped = statusFor(e.kind);
    if (mapped) last = mapped.status;
  }
  return last;
}

// A PR the operator queued by hand: the board's r, or y at the end of a review
// pass. Recording the section alongside the status moves the row now instead of
// leaving it where it was until the next heartbeat re-reports it.
export function emitQueuedToMerge(ev: { key: string; label: string; pr: number }): void {
  emitStatus({ kind: "ready_to_merge", ...ev });
  emitSection({ kind: sectionKind("merge"), ...ev });
}

// The section counterpart of emitStatus: append only when the key's section
// actually changes. The daemon reports every open PR's section each heartbeat,
// so without this the log would fill with restatements.
export function emitSection(ev: Omit<YimbotEvent, "ts"> & { ts?: number }): void {
  let last: Section | undefined;
  for (const e of readEvents()) {
    if (e.key !== ev.key) continue;
    const mapped = sectionFor(e.kind);
    if (mapped) last = mapped;
  }
  if (last !== undefined && last === sectionFor(ev.kind)) return;
  emitEvent(ev);
}

// The reason a raise event carries; events persisted before reasons existed
// default by kind (needs_input was always a session waiting on a person, and
// every reason-less flagged was the manual toggle).
function reasonFor(e: YimbotEvent): string {
  return e.reason ?? (e.kind === "needs_input" ? "input" : "manual");
}

export type Attention = { reasons: Set<string>; clearedAt: number | null };

// Fold each key's attention timeline into its set of raise reasons (in raise
// order) plus the timestamp of its last clear. Walking events in time order, a
// needs-input or flagged event adds its reason, and an input-received or manual
// unflag clears the whole set while recording when: human engagement
// acknowledges every pending reason at once, and only a signal NEWER than that
// acknowledgment may re-raise (see emitFlagged). Status events never clear
// anything: the flag strictly means a human must look, so an automated
// transition (a conflict fix or CI fix spawning) must not swallow a pending ask.
export function foldAttention(events: YimbotEvent[]): Map<string, Attention> {
  const att = new Map<string, Attention>();
  for (const e of events) {
    if (e.kind === "needs_input" || e.kind === "flagged") {
      let a = att.get(e.key);
      if (!a) att.set(e.key, (a = { reasons: new Set(), clearedAt: null }));
      a.reasons.add(reasonFor(e));
    } else if (e.kind === "input_received" || e.kind === "unflagged") {
      let a = att.get(e.key);
      if (!a) att.set(e.key, (a = { reasons: new Set(), clearedAt: null }));
      a.reasons.clear();
      a.clearedAt = e.ts;
    }
  }
  return att;
}

// Fold each key's placement timeline into its current section: last section
// event wins. A key the daemon has never reported on (a task row with no PR,
// or a log written before section events existed) is absent, and reduceRows
// defaults it to the tasks pane.
export function foldSections(events: YimbotEvent[]): Map<string, Section> {
  const sections = new Map<string, Section>();
  for (const e of events) {
    const mapped = sectionFor(e.kind);
    if (mapped) sections.set(e.key, mapped);
  }
  return sections;
}

// Raise the attention flag for a key, deduped per (key, reason) against the
// folded state: a persisting condition re-noticed every tick appends nothing
// while its reason is already up (so it never truncates other rows' history),
// and a second distinct reason still lands. `signalTs` is when the underlying
// condition last changed (a comment's or review's timestamp): a raise whose
// signal is not newer than the key's last clear is dropped, so an unflag
// acknowledges the condition and only fresh signals re-raise. Without a
// signalTs the old behavior stands: any notice after an unflag re-raises.
export function emitFlagged(ev: Omit<YimbotEvent, "ts" | "kind"> & { reason: string; signalTs?: number }): void {
  const a = foldAttention(readEvents()).get(ev.key);
  if (a?.reasons.has(ev.reason)) return;
  if (ev.signalTs !== undefined && a?.clearedAt != null && ev.signalTs <= a.clearedAt) return;
  const { signalTs: _signalTs, ...rest } = ev;
  emitEvent({ ...rest, kind: "flagged" });
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
    const e = parseLine(line);
    if (e) out.push(e);
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
  // The pane this row belongs in, independent of status. See Section above.
  section: Section;
  ts: number;
  startTs: number;
  flagged: boolean;
  // The pending raise reasons, in raise order; flagged === (length > 0).
  flagReasons: string[];
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
  opts: { keepMergedMs?: number; maxRows?: number; manualLiveKeys?: Set<string> } = {},
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
      section: "tasks",
      ts: e.ts,
      startTs,
      flagged: false,
      flagReasons: [],
    });
  }

  // A merged row has no live PR left to report a section, so it keeps whatever
  // it last had; the merge pane is where merged rows have always shown, so
  // force it there rather than dropping it into tasks. Keyed on the merged
  // status rather than on `terminal`, because `refined` is terminal too and a
  // refined ticket has no PR and never entered the queue.
  const sections = foldSections(events);
  for (const row of byKey.values()) {
    row.section = row.status === MERGED_STATUS ? "merge" : (sections.get(row.key) ?? "tasks");
  }

  const attention = foldAttention(events);
  for (const row of byKey.values()) {
    row.flagReasons = [...(attention.get(row.key)?.reasons ?? [])];
    row.flagged = row.flagReasons.length > 0;
  }

  // A terminal key whose worktree still has a live session is manual work in
  // progress (cleanup declined the teardown), not history: show it as working
  // instead of "merged"/aging it out. `manualLiveKeys` carries those keys.
  const manualLive = opts.manualLiveKeys ?? new Set<string>();
  let rows = [...byKey.values()]
    .map((r) =>
      r.terminal && manualLive.has(r.key)
        ? { ...r, status: "working (manual)", terminal: false, section: sections.get(r.key) ?? "tasks" }
        : r,
    )
    .filter((r) => !(r.terminal && now - r.ts > keepMergedMs));
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
