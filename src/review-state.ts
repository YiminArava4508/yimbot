// src/review-state.ts
// Per-review state that survives closing the TUI: viewed-file marks, the AI
// review plan, and the flow annotation. Persisted next to the events log (the
// mode/refine file pattern). Keyed by "<pr>:<headSha>": a new push changes the
// SHA, orphaning the old entry, so a re-review of new code starts clean and
// regroups. The groups and flow payloads are stored opaquely; the overlay
// validates them against the diff it actually fetched.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { eventsLogPath } from "./events.ts";

const MAX_ENTRIES = 50;

export type ReviewEntry = { viewed: string[]; groups?: unknown; flow?: unknown };

export function reviewStateFilePath(): string {
  return join(dirname(eventsLogPath()), "review-state.json");
}

export function stateKey(pr: number, headSha: string): string {
  return `${pr}:${headSha}`;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// Entries used to be a bare array of viewed paths; a file written by that
// version still reads, so an in-flight review keeps its checkmarks over the
// upgrade (it just has no cached plan yet).
function parseEntry(v: unknown): ReviewEntry | null {
  if (Array.isArray(v)) return { viewed: stringList(v) };
  if (v === null || typeof v !== "object") return null;
  const o = v as { viewed?: unknown; groups?: unknown; flow?: unknown };
  const entry: ReviewEntry = { viewed: stringList(o.viewed) };
  if (o.groups !== undefined) entry.groups = o.groups;
  if (o.flow !== undefined) entry.flow = o.flow;
  return entry;
}

export function parseReviewState(raw: string): Record<string, ReviewEntry> {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return {};
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out: Record<string, ReviewEntry> = {};
  for (const [k, v] of Object.entries(obj)) {
    const entry = parseEntry(v);
    if (entry) out[k] = entry;
  }
  return out;
}

// Pure update: merges `patch` onto this SHA's entry (so saving marks keeps the
// cached plan and vice versa), replaces any entry for the same PR under an
// older SHA, and bounds the file by dropping the oldest insertion-order
// entries beyond MAX_ENTRIES.
export function withEntry(
  state: Record<string, ReviewEntry>,
  pr: number,
  headSha: string,
  patch: Partial<ReviewEntry>,
): Record<string, ReviewEntry> {
  const key = stateKey(pr, headSha);
  const prefix = `${pr}:`;
  const next: Record<string, ReviewEntry> = {};
  for (const [k, v] of Object.entries(state)) {
    if (!k.startsWith(prefix)) next[k] = v;
  }
  next[key] = { ...(state[key] ?? { viewed: [] }), ...patch };
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) {
    delete next[k];
  }
  return next;
}

function readState(): Record<string, ReviewEntry> {
  try {
    return parseReviewState(readFileSync(reviewStateFilePath(), "utf8"));
  } catch {
    return {};
  }
}

function update(pr: number, headSha: string, patch: Partial<ReviewEntry>): void {
  const next = withEntry(readState(), pr, headSha, patch);
  try {
    writeFileSync(reviewStateFilePath(), JSON.stringify(next) + "\n");
  } catch {
    // Best-effort persistence, like writeMode: the in-memory state still works.
  }
}

export function readViewed(pr: number, headSha: string): Set<string> {
  return new Set(readState()[stateKey(pr, headSha)]?.viewed ?? []);
}

export function writeViewed(pr: number, headSha: string, viewed: Set<string>): void {
  update(pr, headSha, { viewed: [...viewed] });
}

// The cached review plan, still as it was written: the caller re-validates it
// against the diff before showing it.
export function readGroups(pr: number, headSha: string): unknown | null {
  return readState()[stateKey(pr, headSha)]?.groups ?? null;
}

export function writeGroups(pr: number, headSha: string, groups: unknown): void {
  update(pr, headSha, { groups });
}

// The cached flow annotation, unvalidated the same way the plan is: the
// overlay re-checks it against the architecture map it actually loaded.
export function readFlow(pr: number, headSha: string): unknown | null {
  return readState()[stateKey(pr, headSha)]?.flow ?? null;
}

export function writeFlow(pr: number, headSha: string, flow: unknown): void {
  update(pr, headSha, { flow });
}
