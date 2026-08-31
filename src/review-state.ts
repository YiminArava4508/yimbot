// src/review-state.ts
// Viewed-file marks for reviews, persisted next to the events log
// (the mode/refine file pattern) so a review survives closing the TUI.
// Keyed by "<pr>:<headSha>": a new push changes the SHA, orphaning the old
// marks, so a re-review of new code starts clean.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { eventsLogPath } from "./events.ts";

const MAX_ENTRIES = 50;

export function reviewStateFilePath(): string {
  return join(dirname(eventsLogPath()), "review-state.json");
}

export function stateKey(pr: number, headSha: string): string {
  return `${pr}:${headSha}`;
}

export function parseReviewState(raw: string): Record<string, string[]> {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return {};
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
  }
  return out;
}

// Pure update: replaces any entry for the same PR (older SHAs are dead once a
// new review of that PR is saved) and bounds the file by dropping the oldest
// insertion-order entries beyond MAX_ENTRIES.
export function withViewed(
  state: Record<string, string[]>,
  pr: number,
  headSha: string,
  viewed: string[],
): Record<string, string[]> {
  const prefix = `${pr}:`;
  const next: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(state)) {
    if (!k.startsWith(prefix)) next[k] = v;
  }
  next[stateKey(pr, headSha)] = viewed;
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) {
    delete next[k];
  }
  return next;
}

export function readViewed(pr: number, headSha: string): Set<string> {
  let raw = "";
  try {
    raw = readFileSync(reviewStateFilePath(), "utf8");
  } catch {
    return new Set();
  }
  return new Set(parseReviewState(raw)[stateKey(pr, headSha)] ?? []);
}

export function writeViewed(pr: number, headSha: string, viewed: Set<string>): void {
  let raw = "";
  try {
    raw = readFileSync(reviewStateFilePath(), "utf8");
  } catch {
    // Missing file: first review.
  }
  const next = withViewed(parseReviewState(raw), pr, headSha, [...viewed]);
  try {
    writeFileSync(reviewStateFilePath(), JSON.stringify(next) + "\n");
  } catch {
    // Best-effort persistence, like writeMode: the in-memory marks still work.
  }
}
