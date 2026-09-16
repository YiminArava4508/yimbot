import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export type QueueEntry = { key: string; cmd: string; since: number };
export type QueueState = { running: QueueEntry | null; waiting: QueueEntry[] };

// Border plus a space of padding each side, so the interior is WIDTH - 4. Wide
// enough for a key and the head of its command: which command holds the slot is
// the thing an operator is looking at the pane to learn.
export const QUEUE_PANE_WIDTH = 28;

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

function fit(text: string, room: number): string {
  if (room <= 0) return "";
  return text.length <= room ? text : `${text.slice(0, room - 1)}…`;
}

// Every row carries a 2-char prefix ("▶ " or two spaces), so the key itself gets
// less room than the pane interior. The key is capped short of what it could
// take so a long one cannot squeeze the command out of the row entirely.
const KEY_ROOM = 10;

function entryRow(mark: string, entry: QueueEntry, color?: string): string {
  const key = fit(entry.key, KEY_ROOM);
  const head = color ? `{${color}-fg}${mark}${key}{/${color}-fg}` : `${mark}${key}`;
  const cmd = fit(entry.cmd, QUEUE_PANE_WIDTH - 4 - mark.length - key.length - 1);
  return cmd ? `${head} {grey-fg}${cmd}{/grey-fg}` : head;
}

export function queueRows(state: QueueState): string[][] {
  const header = [["QUEUE"]];
  if (!state.running && state.waiting.length === 0) return [...header, ["{grey-fg}idle{/grey-fg}"]];
  const rows: string[][] = [...header];
  if (state.running) rows.push([entryRow("▶ ", state.running, "green")]);
  for (const w of state.waiting) rows.push([entryRow("  ", w)]);
  return rows;
}
