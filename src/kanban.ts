import { cellWidth, fitCell, fmtDuration, grey, repoDisplayName, titleCell } from "./board-format.ts";
import { HELD_MERGED_STATUS, HELD_SLICE_STATUS, MERGED_STATUS, isFlagged, isParentRow, isReadyClaim, type BoardRow, type Section } from "./events.ts";
import type { CycleBoard } from "./linear-api.ts";

export type Card = { key: string; title: string; stateName: string; row: BoardRow | null };
export type Column = { id: string; title: string; color: string; cards: Card[] };

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const TYPE_COLORS: Record<string, string> = {
  triage: "magenta",
  backlog: "grey",
  unstarted: "white",
  started: "yellow",
  completed: "green",
  canceled: "red",
};

export function columnColor(state: { type: string; color: string }): string {
  if (HEX_COLOR.test(state.color)) return state.color;
  return TYPE_COLORS[state.type] ?? "grey";
}

const TYPE_ORDER = ["triage", "backlog", "unstarted", "started", "completed", "canceled"];
const HIDDEN_WHEN_EMPTY = new Set(["triage", "canceled"]);

function typeRank(type: string): number {
  const i = TYPE_ORDER.indexOf(type);
  return i === -1 ? TYPE_ORDER.length : i;
}

export function pickRow(rows: BoardRow[], identifier: string): BoardRow | null {
  const matches = rows.filter((r) => r.label === identifier);
  return matches.find((r) => !r.terminal) ?? matches[0] ?? null;
}

export function buildColumns(board: CycleBoard, rows: BoardRow[]): Column[] {
  const states = [...board.states].sort(
    (a, b) => typeRank(a.type) - typeRank(b.type) || a.position - b.position,
  );
  const columns: Column[] = [];
  for (const state of states) {
    const cards = board.issues
      .filter((i) => i.stateId === state.id)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((i) => ({
        key: i.identifier,
        title: i.title,
        stateName: state.name,
        row: pickRow(rows, i.identifier),
      }));
    if (cards.length === 0 && HIDDEN_WHEN_EMPTY.has(state.type)) continue;
    columns.push({ id: state.id, title: state.name, color: columnColor(state), cards });
  }
  return columns;
}

const WRAP_MIN_WIDTH = 36;
const CHIP = /^\{[a-z]+-fg\}\[[^\]]*\]\{\/[a-z]+-fg\}/;

function takeFitting(word: string, room: number): string {
  let out = "";
  for (const ch of word) {
    if (cellWidth(out + ch) > room) break;
    out += ch;
  }
  return out;
}

function wrapTitle(text: string, width: number): string[] {
  const chip = CHIP.exec(text)?.[0] ?? "";
  const body = text.slice(chip.length).trim();
  if (width < WRAP_MIN_WIDTH) {
    if (!chip) return [fitCell(body, width)];
    return [`${chip} ${fitCell(body, width - cellWidth(chip) - 1)}`.trimEnd()];
  }
  const words = body.split(/\s+/).filter(Boolean);
  let first = chip;
  while (words.length > 0) {
    const word = words[0];
    const next = first ? `${first} ${word}` : word;
    if (cellWidth(next) <= width) {
      first = next;
      words.shift();
      continue;
    }
    if (!first) {
      first = takeFitting(word, width);
      words[0] = word.slice(first.length);
    }
    break;
  }
  const rest = words.join(" ");
  return rest ? [first, fitCell(rest, width)] : [first];
}

const SECTION_LABEL: Partial<Record<Section, string>> = { review: "ready to review", merge: "ready to merge" };

const OWN_STATUSES = new Set([MERGED_STATUS, HELD_SLICE_STATUS, HELD_MERGED_STATUS]);

function statusText(row: BoardRow): string {
  const label = SECTION_LABEL[row.section];
  if (isParentRow(row) || !label) return row.status;
  if (row.terminal || OWN_STATUSES.has(row.status)) return row.status;
  if (isReadyClaim(row.status)) return label;
  return `${label}, ${row.status}`;
}

export type Tone = "ok" | "wait" | "alert" | "idle";

const TONE_RANK: Record<Tone, number> = { idle: 0, ok: 1, wait: 2, alert: 3 };
const TONE_COLOR: Record<Tone, string> = { ok: "green", wait: "yellow", alert: "red", idle: "grey" };

const STATUS_TONES: Record<string, Tone> = {
  working: "ok",
  "working (manual)": "ok",
  "ci green": "ok",
  "ready to merge": "ok",
  merged: "ok",
  "fixing CI": "ok",
  "addressing review": "ok",
  unblocking: "ok",
  "resolving conflict": "ok",
  refining: "ok",
  "qa: in session": "ok",
  "ready to review": "wait",
  "in review": "wait",
  "draft pr": "wait",
  "ready: r to queue": "wait",
  "qa: awaiting deploy": "wait",
  "CI failing": "alert",
  "merge queue blocked": "alert",
  "unresolved threads": "alert",
  "needs input": "alert",
  "needs decision": "alert",
  "review findings": "alert",
  "qa failed": "alert",
};

function partTone(part: string): Tone {
  if (part.startsWith("waiting on ") || part.startsWith("qa: waiting on ")) return "wait";
  return STATUS_TONES[part] ?? "idle";
}

export function statusTone(status: string, flagged: boolean): Tone {
  if (flagged) return "alert";
  return status.split(", ").map(partTone).reduce<Tone>((worst, t) => (TONE_RANK[t] > TONE_RANK[worst] ? t : worst), "idle");
}

const ACCENT = /^(#[0-9a-fA-F]{6}|[a-z]+)$/;

function tag(color: string, text: string): string {
  return text ? `{${color}-fg}${text}{/${color}-fg}` : "";
}

function keyCell(key: string, accent: string | undefined): string {
  if (!key || !accent || !ACCENT.test(accent)) return key;
  return `{bold}${tag(accent, key)}{/bold}`;
}

export function cardLines(card: Card, width: number, now: number, codebaseName: string, accent?: string): string[] {
  const row = card.row;
  const extras: string[] = [];
  if (row) {
    const showPr = row.pr != null && !isParentRow(row);
    extras.push(showPr ? tag("cyan", `#${row.pr}`) : grey(fmtDuration((row.terminal ? row.ts : now) - row.startTs)));
    if (isFlagged(row)) extras.push("{red-fg}⚑{/red-fg}");
  }
  const suffix = extras.join(" ");
  const keyRoom = width - cellWidth(suffix) - 1;
  const head = keyRoom >= 1 ? [keyCell(fitCell(card.key, keyRoom), accent), ...extras] : [keyCell(fitCell(card.key, width), accent)];
  const lines = [head.join(" "), ...wrapTitle(titleCell({ key: card.key, title: card.title }), width)];
  if (!row) return [...lines, grey(fitCell(card.stateName, width))];
  const status = statusText(row);
  lines.push(tag(TONE_COLOR[statusTone(status, isFlagged(row))], fitCell(status, width)));
  const repo = repoDisplayName(row, codebaseName);
  if (repo) lines.push(grey(fitCell(repo, width)));
  return lines;
}

export function focusOrder(columns: Column[], hasParents: boolean): string[] {
  const ids = columns.map((c) => c.id);
  return hasParents ? [...ids, "parents"] : ids;
}

export function stepFocus(order: string[], current: string, dir: "next" | "prev"): string {
  const i = order.indexOf(current);
  if (i === -1) return order[0] ?? current;
  const next = Math.min(order.length - 1, Math.max(0, i + (dir === "next" ? 1 : -1)));
  return order[next];
}

export function cycleFocus(order: string[], current: string): string {
  const i = order.indexOf(current);
  if (i === -1) return order[0] ?? current;
  return order[(i + 1) % order.length];
}

export function visibleWindow(
  total: number,
  focusedIndex: number,
  prevStart: number,
  width: number,
  minWidth = 24,
): { start: number; count: number; colWidth: number } {
  const count = Math.max(1, Math.min(total, Math.floor(width / minWidth)));
  let start = Math.min(prevStart, Math.max(0, total - count));
  if (focusedIndex < start) start = focusedIndex;
  else if (focusedIndex >= start + count) start = focusedIndex - count + 1;
  start = Math.max(0, start);
  return { start, count, colWidth: Math.floor(width / count) };
}
