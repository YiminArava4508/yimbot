// src/fix-timers.ts
// The review step's stale-reap timers ("<pr>:<kind>" -> epoch ms first seen in
// flight), persisted next to the events log so a daemon restart does not hand
// every running fixer a fresh 90-minute clock. Entries for fixers no longer in
// flight are dropped by reviewOnce, so the file prunes itself.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { eventsLogPath } from "./events.ts";

export function fixTimersFilePath(): string {
  return join(dirname(eventsLogPath()), "fix-timers.json");
}

export function parseFixSeenAt(raw: string): Map<string, number> {
  const out = new Map<string, number>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "number" && Number.isFinite(value)) out.set(key, value);
  }
  return out;
}

export function loadFixSeenAt(): Map<string, number> {
  try {
    return parseFixSeenAt(readFileSync(fixTimersFilePath(), "utf8"));
  } catch {
    return new Map();
  }
}

export function saveFixSeenAt(seenAt: Map<string, number>): void {
  try {
    writeFileSync(fixTimersFilePath(), JSON.stringify(Object.fromEntries(seenAt)) + "\n");
  } catch {
    // Best-effort, like review-state.json: the in-memory timers still work.
  }
}
