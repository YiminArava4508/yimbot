// src/last-update.ts
// The last self-update yimbot applied, kept in one file that each update
// overwrites, so the header can show when the running code last changed.
import { readFileSync, writeFileSync } from "node:fs";

export type LastUpdate = { at: number; from: string; to: string };

// scripts/run.sh sets YIMBOT_UPDATED_FROM on the boot after an exit 75 and
// YIMBOT_ROLLED_BACK when it moved back off a crashing sha instead.
export function recordLastUpdate(path: string, env: NodeJS.ProcessEnv, head: string, now: number = Date.now()): void {
  const from = env.YIMBOT_UPDATED_FROM;
  if (!from || from === head || env.YIMBOT_ROLLED_BACK) return;
  const record: LastUpdate = { at: now, from, to: head };
  try {
    writeFileSync(path, JSON.stringify(record) + "\n");
  } catch (err) {
    console.error(`[self-update] could not record the update: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function readLastUpdate(path: string): LastUpdate | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const r = raw as Partial<LastUpdate> | null;
  if (typeof r?.at !== "number" || typeof r.from !== "string" || typeof r.to !== "string") return null;
  return { at: r.at, from: r.from, to: r.to };
}
