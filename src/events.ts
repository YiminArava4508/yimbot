import { EventEmitter } from "node:events";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { envOr } from "./env.ts";
import type { MergedPR, OpenPR } from "./gh.ts";

export type EventKind =
  | "task_started"
  | "review_started"
  | "ci_fix_started"
  | "conflict_fix_started"
  | "blocked_fix_started"
  | "merge_blocked"
  | "ci_failing"
  | "review_unresolved"
  | "ready_to_merge"
  | "draft_pr"
  | "ready_unqueued"
  | "ready_regressed"
  | "awaiting_slices"
  | "tracking"
  | "merged"
  | "flagged"
  | "unflagged"
  | "needs_input"
  | "input_received"
  | "needs_decision"
  | "review_findings"
  | "refine_started"
  | "refined"
  | "qa_waiting"
  | "qa_awaiting_deploy"
  | "qa_started"
  | "qa_posted"
  | "qa_failed"
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
  // owner/name when `pr` lives in one of EXTRA_REPOS; absent for the codebase
  // repo. The TUI's gh calls for the row route through it.
  repo?: string;
  // Why a raise event (needs_input/flagged) raised the flag: input,
  // changes-requested, human-comment, stuck, decision, findings, or manual.
  // Absent on events from older builds; the fold defaults those by kind.
  reason?: string;
  // The tmux pane the emitting hook ran in. Every hook-emitted event carries
  // it; the autonomous-mode nudge uses it to target the exact stuck Claude, and
  // the stale-raise step to notice that Claude is gone.
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

// The board row a PR belongs to. A codebase-repo PR folds into its ticket's
// row; a PR in an EXTRA_REPOS repo gets a row of its own, keyed by ticket and
// repo but labeled like the ticket, so a ticket spanning repos shows one row
// per PR instead of one row flipping between them.
export function prRowKey(opts: { branch: string; pr: number; repo?: string }): { key: string; label: string } {
  const base = deriveKey({ branch: opts.branch, pr: opts.pr });
  if (!opts.repo) return base;
  return { key: `${base.key}@${opts.repo}`, label: base.label };
}

// The ticket (or pr:<n>) key behind a row key: an extra-repo row's key minus
// its repo suffix. Worktrees and sessions are keyed by ticket, so every lookup
// from a row to its session goes through this.
export function ticketKeyOf(key: string): string {
  const at = key.indexOf("@");
  return at === -1 ? key : key.slice(0, at);
}

// Events from builds before prRowKey keyed an extra-repo PR by ticket alone,
// with the repo only in `repo`. Fold them onto the row they would get today,
// so a replayed events log neither duplicates the row nor leaks the PR onto
// the ticket row.
function rowKeyOf(e: YimbotEvent): string {
  if (e.repo && !e.key.includes("@")) return `${e.key}@${e.repo}`;
  return e.key;
}

// A ticket-keyed board row can cover several PRs at once: every branch carrying
// the same ticket slug derives to one key, so a follow-up or stacked PR on a
// ticket shares its row (as does a split slice branched off the parent's slug
// rather than its own subticket -- the skills name slices after their subticket,
// but nothing enforces it). One merged branch must not mark the whole row merged
// while another open PR still maps to it, so return only the merged branches
// whose key no open PR still claims.
export function branchesFullyMerged(merged: Set<string>, open: Set<string>): string[] {
  const openKeys = new Set([...open].map((b) => deriveKey({ branch: b }).key));
  return [...merged].filter((b) => !openKeys.has(deriveKey({ branch: b }).key));
}

// The board rows to mark merged: every merged PR's row that no open PR still
// maps to. Rows are per ticket per repo, so a codebase PR waits on the
// ticket's other codebase PRs and an extra-repo PR on the ticket's other PRs
// in that repo; the worktree teardown, not the row, waits across repos.
export function mergedRowKeys(merged: MergedPR[], open: OpenPR[]): { key: string; label: string }[] {
  const openKeys = new Set(open.map((o) => prRowKey({ branch: o.headRefName, pr: o.number, repo: o.repo }).key));
  const out: { key: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const p of merged) {
    const k = prRowKey({ branch: p.headRefName, pr: p.number, repo: p.repo });
    if (openKeys.has(k.key) || seen.has(k.key)) continue;
    seen.add(k.key);
    out.push(k);
  }
  return out;
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
  merge_blocked: { status: "merge queue blocked", terminal: false },
  ci_failing: { status: "CI failing", terminal: false },
  review_unresolved: { status: "unresolved threads", terminal: false },
  ready_to_merge: { status: "ready to merge", terminal: false },
  draft_pr: { status: "draft pr", terminal: false },
  ready_unqueued: { status: "ready: r to queue", terminal: false },
  ready_regressed: { status: "working", terminal: false },
  awaiting_slices: { status: "waiting on slices", terminal: false },
  tracking: { status: "tracker ticket", terminal: false },
  merged: { status: "merged", terminal: true },
  needs_decision: { status: "needs decision", terminal: false },
  review_findings: { status: "review findings", terminal: false },
  refine_started: { status: "refining", terminal: false },
  refined: { status: "refined", terminal: true },
  qa_waiting: { status: "qa: waiting on children", terminal: false },
  qa_awaiting_deploy: { status: "qa: awaiting deploy", terminal: false },
  qa_started: { status: "qa: in session", terminal: false },
  qa_posted: { status: "qa posted", terminal: true },
  // Terminal like `refined`: a failed QA run has nothing left driving it, and
  // the row has to stay put until a human looks at it.
  qa_failed: { status: "qa failed", terminal: true },
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
export const HELD_SLICE_STATUS = "merged, waiting on slices";
export const HELD_MERGED_STATUS = "merged, waiting on ticket";
export const AWAITING_SLICES_STATUS = STATUS.awaiting_slices!.status;
export const TRACKING_STATUS = STATUS.tracking!.status;
export const WORKING_STATUS = STATUS.task_started!.status;

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
  // A reason-scoped unflag (stale-raise.ts) is not an acknowledgment and
  // carries no clearedAt, so it must not stand in for the key's real clear.
  if ((e.kind === "unflagged" && !e.reason) || e.kind === "input_received") return "clear";
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
export function emitQueuedToMerge(ev: { key: string; label: string; pr: number; repo?: string }): void {
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

// panes maps each pending reason to the tmux panes that raised it via a session
// hook (a ticket session and a pr-N-fix window on the same branch share a key).
// Daemon-side raises carry no pane and have no entry.
export type Attention = { reasons: Set<string>; panes: Map<string, Set<string>>; clearedAt: number | null };

// Fold each key's attention timeline into its set of raise reasons (in raise
// order) plus the timestamp of its last clear. Walking events in time order, a
// needs-input or flagged event adds its reason, and an input-received or manual
// unflag clears the whole set while recording when: human engagement
// acknowledges every pending reason at once, and only a signal NEWER than that
// acknowledgment may re-raise (see emitFlagged). An unflag that names a reason
// drops just that reason (the raiser's session died, see stale-raise.ts) and is
// not an acknowledgment, so clearedAt stays. Status events never clear
// anything: the flag strictly means a human must look, so an automated
// transition (a conflict fix or CI fix spawning) must not swallow a pending ask.
export function foldAttention(events: YimbotEvent[]): Map<string, Attention> {
  const att = new Map<string, Attention>();
  const entry = (key: string): Attention => {
    let a = att.get(key);
    if (!a) att.set(key, (a = { reasons: new Set(), panes: new Map(), clearedAt: null }));
    return a;
  };
  for (const e of events) {
    if (e.kind === "needs_input" || e.kind === "flagged") {
      const a = entry(e.key);
      const reason = reasonFor(e);
      a.reasons.add(reason);
      if (e.pane) {
        let panes = a.panes.get(reason);
        if (!panes) a.panes.set(reason, (panes = new Set()));
        panes.add(e.pane);
      }
    } else if (e.kind === "unflagged" && e.reason) {
      const a = entry(e.key);
      a.reasons.delete(e.reason);
      a.panes.delete(e.reason);
    } else if (e.kind === "input_received" || e.kind === "unflagged") {
      const a = entry(e.key);
      a.reasons.clear();
      a.panes.clear();
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
    if (mapped) sections.set(rowKeyOf(e), mapped);
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
  repo?: string;
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
  opts: {
    keepMergedMs?: number;
    maxRows?: number;
    manualLiveKeys?: Set<string>;
    heldSliceKeys?: Set<string>;
    heldMergedKeys?: Set<string>;
  } = {},
): BoardRow[] {
  const keepMergedMs = opts.keepMergedMs ?? keepMergedMsDefault();
  const maxRows = opts.maxRows ?? maxRowsDefault();

  const byKey = new Map<string, BoardRow>();
  for (const e of events) {
    const mapped = statusFor(e.kind);
    if (!mapped) continue; // flag signals + any kind retired in a newer build
    const key = rowKeyOf(e);
    const prev = byKey.get(key);
    const startTs = prev ? (prev.terminal ? e.ts : prev.startTs) : e.ts;
    byKey.set(key, {
      key,
      label: e.label,
      title: e.title ?? prev?.title,
      pr: e.pr ?? prev?.pr,
      repo: e.repo ?? prev?.repo,
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
  // A merged split slice whose worktree cleanup is holding for the rest of
  // its group (`heldSliceKeys`), or a merged worktree cleanup is holding for
  // the ticket's other PRs or its Linear state (`heldMergedKeys`), is neither
  // history nor manual work: say what it is waiting on and keep it on the
  // merge pane until the hold lifts.
  const manualLive = opts.manualLiveKeys ?? new Set<string>();
  const heldSlices = opts.heldSliceKeys ?? new Set<string>();
  const heldMerged = opts.heldMergedKeys ?? new Set<string>();
  const holdRow = (r: BoardRow): BoardRow => {
    if (!r.terminal) return r;
    if (r.status === MERGED_STATUS && heldSlices.has(r.key)) {
      return { ...r, status: HELD_SLICE_STATUS, terminal: false };
    }
    if (r.status === MERGED_STATUS && heldMerged.has(r.key)) {
      return { ...r, status: HELD_MERGED_STATUS, terminal: false };
    }
    if (manualLive.has(r.key)) {
      return { ...r, status: "working (manual)", terminal: false, section: sections.get(r.key) ?? "tasks" };
    }
    return r;
  };
  let rows = [...byKey.values()]
    .map(holdRow)
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

// Keep only rows something still backs: a non-terminal row survives iff a
// worktree exists for its key OR its PR is still open, so a session/worktree
// reaped before merge stops showing as active while genuinely live work does
// not vanish. The open-PR half matters because a worktree is a local
// convenience, not the work: a split slice the split flow never ran
// split-pr.sh for, or a session reaped early, leaves an open PR with nothing on
// this machine, and the operator still has to be able to review and queue it.
//
// Terminal (merged) rows are kept regardless: their worktree is already gone by
// design, and reduceRows still ages them out past the linger window.
//
// `liveKeys` is the deriveKey() keys of the codebase's worktrees; `openPrKeys`
// is the same for the instance's open PRs. An empty openPrKeys (review step off,
// or no successful gh list yet) leaves the worktree rule as the only one.
export function filterToLiveRows(
  rows: BoardRow[],
  liveKeys: Set<string>,
  openPrKeys: Set<string> = new Set(),
): BoardRow[] {
  return rows.filter((r) => r.terminal || liveKeys.has(r.key) || openPrKeys.has(r.key));
}
