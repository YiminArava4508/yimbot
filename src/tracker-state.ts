// Linear trackers: In Progress parents decomposed in Linear, with children and a
// 0-point estimate, that get a board row but no session. The deploy step owns
// the set; it is persisted next to the events log so the TUI can keep the rows
// on the board (they have no worktree or PR to back them) across a restart.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { eventsLogPath } from "./events.ts";

export type TrackerShape = { estimate?: number | null; hasChildren?: boolean };

// The refine convention: a decomposed parent is zeroed and its subtickets carry
// the work. Children alone would also catch a parent still carrying its own
// work; a zero estimate alone would catch a 0-point leaf.
export function isLinearTracker(issue: TrackerShape): boolean {
  return issue.hasChildren === true && issue.estimate === 0;
}

export function trackerStateFilePath(): string {
  return join(dirname(eventsLogPath()), "tracker-state.json");
}

export function parseTrackerState(raw: string): Set<string> {
  const out = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
  const { trackers } = parsed as { trackers?: unknown };
  if (!Array.isArray(trackers)) return out;
  for (const t of trackers) if (typeof t === "string") out.add(t);
  return out;
}

export function serializeTrackerState(trackers: Set<string>): string {
  return JSON.stringify({ trackers: [...trackers] }) + "\n";
}

export function loadTrackerState(): Set<string> {
  try {
    return parseTrackerState(readFileSync(trackerStateFilePath(), "utf8"));
  } catch {
    return new Set();
  }
}

export function saveTrackerState(trackers: Set<string>): void {
  try {
    writeFileSync(trackerStateFilePath(), serializeTrackerState(trackers));
  } catch {
    // Best-effort, like qa-state.json: the in-memory set still drives the tick.
  }
}
