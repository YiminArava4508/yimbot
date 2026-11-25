// src/master-merge-state.ts
// Per-PR review state for the master merge step (PR number -> last reviewed
// sha, verdict, whether findings were commented, review attempts), persisted
// next to the events log so a restart does not re-review or re-comment.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { eventsLogPath } from "./events.ts";

export type MasterMergeEntry = { sha: string; clean: boolean; commented: boolean; attempts: number };

export function masterMergeStatePath(): string {
  return join(dirname(eventsLogPath()), "master-merge.json");
}

function parseEntry(value: unknown): MasterMergeEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const e = value as Record<string, unknown>;
  if (typeof e.sha !== "string" || e.sha === "") return null;
  if (typeof e.clean !== "boolean" || typeof e.commented !== "boolean") return null;
  if (typeof e.attempts !== "number" || !Number.isFinite(e.attempts)) return null;
  return { sha: e.sha, clean: e.clean, commented: e.commented, attempts: e.attempts };
}

export function parseMasterMergeState(raw: string): Record<string, MasterMergeEntry> {
  const out: Record<string, MasterMergeEntry> = {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
  for (const [key, value] of Object.entries(parsed)) {
    const entry = parseEntry(value);
    if (entry) out[key] = entry;
  }
  return out;
}

export function loadMasterMergeState(): Record<string, MasterMergeEntry> {
  try {
    return parseMasterMergeState(readFileSync(masterMergeStatePath(), "utf8"));
  } catch {
    return {};
  }
}

export function saveMasterMergeState(state: Record<string, MasterMergeEntry>): void {
  try {
    writeFileSync(masterMergeStatePath(), JSON.stringify(state) + "\n");
  } catch {
    // Best-effort, like fix-timers.json: a lost write means one re-review.
  }
}
