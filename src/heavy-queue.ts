import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export type QueueEntry = { key: string; cmd: string; since: number };
export type QueueState = { running: QueueEntry | null; waiting: QueueEntry[] };

// Border plus a space of padding each side, so the interior is WIDTH - 4.
export const QUEUE_PANE_WIDTH = 16;

const IDLE: QueueState = { running: null, waiting: [] };

function toEntry(raw: unknown): QueueEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== "string") return null;
  return { key: r.key, cmd: typeof r.cmd === "string" ? r.cmd : "", since: Number(r.since) || 0 };
}

export function parseQueueStatus(json: string): QueueState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return IDLE;
  }
  if (!parsed || typeof parsed !== "object") return IDLE;
  const p = parsed as Record<string, unknown>;
  const waiting = Array.isArray(p.waiting) ? p.waiting.map(toEntry).filter((e): e is QueueEntry => e != null) : [];
  return { running: toEntry(p.running), waiting };
}

// The queue is read through the script rather than by walking the ticket dir
// here, so the staleness rules have exactly one implementation.
export function readQueueState(run: () => string = defaultRun): QueueState {
  try {
    return parseQueueStatus(run());
  } catch {
    return IDLE;
  }
}

function defaultRun(): string {
  return execFileSync("bash", [join(homedir(), ".config/yimbot/heavy-queue.sh"), "status", "--json"], {
    encoding: "utf8",
    timeout: 2000,
  });
}

// Every row carries a 2-char prefix ("▶ " or two spaces), so the key itself
// gets less room than the pane interior.
function fit(key: string): string {
  const room = QUEUE_PANE_WIDTH - 4 - 2;
  return key.length <= room ? key : `${key.slice(0, room - 1)}…`;
}

export function queueRows(state: QueueState): string[][] {
  const header = [["QUEUE"]];
  if (!state.running && state.waiting.length === 0) return [...header, ["{grey-fg}idle{/grey-fg}"]];
  const rows: string[][] = [...header];
  if (state.running) rows.push([`{green-fg}▶ ${fit(state.running.key)}{/green-fg}`]);
  for (const w of state.waiting) rows.push([`  ${fit(w.key)}`]);
  return rows;
}
