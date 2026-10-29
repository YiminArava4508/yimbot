import { basename } from "node:path";
import blessed from "neo-blessed";
import type { BoardRow } from "./events.ts";
import { configFromEnv } from "./settings-model.ts";
import { researchWords, rowType, type TicketType } from "./ticket-type.ts";

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

// What the REPO column reads: nothing until the row has a PR, the codebase
// checkout's directory name for a codebase-repo PR, the name half of the
// owner/name slug for an extra-repo PR.
export function repoDisplayName(row: Pick<BoardRow, "pr" | "repo">, codebaseName: string): string {
  if (row.pr == null) return "";
  if (!row.repo) return codebaseName;
  return row.repo.split("/").pop() ?? row.repo;
}

export function codebaseRepoName(): string {
  return basename(configFromEnv(process.env).codebasePath);
}

export const TYPE_CHIP_COLOR: Record<TicketType, string> = { research: "magenta", pr: "cyan" };

// The TITLE cell: a typed row gets a chip ahead of its title, so the type
// reads at a glance without the board spending a column on a rare marker.
export function titleCell(row: Pick<BoardRow, "key" | "title">, words: string[] = researchWords()): string {
  const title = row.title ?? "";
  const type = rowType(row, words);
  if (!type) return title;
  const color = TYPE_CHIP_COLOR[type];
  return `{${color}-fg}[${type}]{/${color}-fg} ${title}`;
}

export const grey = (text: string): string => (text ? `{grey-fg}${text}{/grey-fg}` : "");

export function fitCell(text: string, room: number): string {
  if (room <= 0) return "";
  if (cellWidth(text) <= room) return text;
  let out = "";
  for (const ch of text) {
    if (cellWidth(out + ch) > room - 1) break;
    out += ch;
  }
  return `${out}…`;
}

// A cell's on-screen width, measured through blessed's own helpers rather than
// reimplemented: Element.strWidth strips tags and then, under fullUnicode,
// counts display columns (a CJK title is two per character, a combining mark
// zero). Padding by String.length instead would size a non-ASCII title wrong
// and knock that pane's columns off the shared grid.
export function cellWidth(cell: string): number {
  return blessed.unicode.strWidth(blessed.helpers.stripTags(cell));
}
