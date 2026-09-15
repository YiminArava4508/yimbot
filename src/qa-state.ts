// The QA step's per-unit phase machine, persisted next to the events log so a
// daemon restart resumes a unit mid-wait instead of forgetting it.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { eventsLogPath } from "./events.ts";

export type QaPhase = "waiting-children" | "awaiting-deploy" | "in-session" | "posted" | "failed";

const PHASES: ReadonlySet<string> = new Set(["waiting-children", "awaiting-deploy", "in-session", "posted", "failed"]);

export type QaUnit = {
  identifier: string;
  id: string;
  repo?: string;
  phase: QaPhase;
  lastPr: number;
  prs: string[];
  mergeSha?: string;
  startedAt?: number;
};

export type QaState = { units: Map<string, QaUnit>; processedPRs: Set<string> };

export function freshQaState(): QaState {
  return { units: new Map(), processedPRs: new Set() };
}

// PR numbers collide across repos, so the processed latch is repo-qualified.
export function prKey(pr: { number: number; repo?: string }): string {
  return `${pr.repo ?? ""}#${pr.number}`;
}

export function qaStateFilePath(): string {
  return join(dirname(eventsLogPath()), "qa-state.json");
}

function isUnit(v: unknown): v is QaUnit {
  if (typeof v !== "object" || v === null) return false;
  const u = v as Record<string, unknown>;
  return (
    typeof u.identifier === "string" &&
    typeof u.id === "string" &&
    typeof u.phase === "string" &&
    PHASES.has(u.phase) &&
    typeof u.lastPr === "number" &&
    Array.isArray(u.prs) &&
    u.prs.every((p) => typeof p === "string")
  );
}

export function parseQaState(raw: string): QaState {
  const out = freshQaState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
  const obj = parsed as { units?: unknown; processedPRs?: unknown };
  if (typeof obj.units === "object" && obj.units !== null) {
    for (const [key, value] of Object.entries(obj.units)) {
      if (isUnit(value)) out.units.set(key, value);
    }
  }
  if (Array.isArray(obj.processedPRs)) {
    for (const p of obj.processedPRs) if (typeof p === "string") out.processedPRs.add(p);
  }
  return out;
}

export function serializeQaState(state: QaState): string {
  return JSON.stringify({ units: Object.fromEntries(state.units), processedPRs: [...state.processedPRs] }) + "\n";
}

export function loadQaState(): QaState {
  try {
    return parseQaState(readFileSync(qaStateFilePath(), "utf8"));
  } catch {
    return freshQaState();
  }
}

export function saveQaState(state: QaState): void {
  try {
    writeFileSync(qaStateFilePath(), serializeQaState(state));
  } catch {
    // Best-effort, like fix-timers.json: the in-memory state still drives the tick.
  }
}
