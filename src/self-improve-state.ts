import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { eventsLogPath } from "./events.ts";
import type { SelfImproveJob } from "./self-improve-jobs.ts";

const pad = (n: number): string => String(n).padStart(2, "0");

function isoWeek(now: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return { year: d.getUTCFullYear(), week: Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7) };
}

export function periodKey(job: SelfImproveJob, now: Date): string {
  if (job.cadence === "weekly") {
    const { year, week } = isoWeek(now);
    return `${year}-W${pad(week)}`;
  }
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function isDue(job: SelfImproveJob, lastRun: string | undefined, now: Date, hourOverride?: number): boolean {
  if (now.getHours() < (hourOverride ?? job.hour)) return false;
  return periodKey(job, now) !== lastRun;
}

export function selfImproveStatePath(): string {
  return join(dirname(eventsLogPath()), "self-improve.json");
}

export function parseSelfImproveState(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export function loadSelfImproveState(): Record<string, string> {
  try {
    return parseSelfImproveState(readFileSync(selfImproveStatePath(), "utf8"));
  } catch {
    return {};
  }
}

export function saveSelfImproveState(state: Record<string, string>): void {
  try {
    writeFileSync(selfImproveStatePath(), JSON.stringify(state) + "\n");
  } catch {
    // Best-effort: the in-memory run still works, the period just repeats after a restart.
  }
}
