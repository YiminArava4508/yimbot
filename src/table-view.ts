import { cellWidth, codebaseRepoName, dimWhenDone, fmtDuration, grey, repoDisplayName, TYPE_CHIP_COLOR } from "./board-format.ts";
import { STUCK_STATUS, isFlagged, isParentRow, type BoardRow } from "./events.ts";
import { QUEUE_PANE_WIDTH } from "./heavy-queue.ts";
import type { OrderEntry } from "./review-order.ts";
import { researchWords, rowType } from "./ticket-type.ts";

export type TableId = "attention" | "tasks" | "review" | "merge";

// Top to bottom: what needs a person first, then the work in flight.
export const TABLE_IDS: readonly TableId[] = ["attention", "tasks", "review", "merge"];

export function isTableId(id: string): id is TableId {
  return (TABLE_IDS as readonly string[]).includes(id);
}

// Below this the board's nine columns no longer fit beside the queue, so the
// queue gives way rather than squeezing the rows it exists to annotate.
export const QUEUE_MIN_SCREEN_WIDTH = 80;

// Header row plus the two border rows; a pane needs one more to show a row.
export const PANE_CHROME_ROWS = 3;
export const PANE_MIN_HEIGHT = PANE_CHROME_ROWS + 1;

// Rows waiting on a person: a session that handed back a decision or review
// findings, or one the stuck detector or the nudge gave up on. They stay In
// Progress in Linear (and in the WIP count); this only lifts them to the top of
// the board so they are not lost among rows that are actually working.
const ATTENTION_STATUSES = new Set(["needs decision", "review findings", STUCK_STATUS]);
const ATTENTION_FLAGS = new Set(["decision", "findings", "stuck"]);

export function needsAttention(r: BoardRow): boolean {
  if (r.terminal) return false;
  return ATTENTION_STATUSES.has(r.status) || r.flagReasons.some((f) => ATTENTION_FLAGS.has(f));
}

// Placement reads the row's section, never its status, except that a row
// needing attention (above) goes to the attention pane wherever its PR sits. The daemon reports the
// section each heartbeat from the facts that actually decide it (the ready
// label, the draft flag), so a queued PR stays in the merge pane while its
// status walks through a CI fix, a conflict fix or a review round. A row only
// moves when the label does. The one exception is the split parents: the
// daemon only ever gives that status to a split's tracking ticket, and it
// outranks whatever section the key's own PR left behind before the split, so
// they leave the work panes for their own.
export function partitionTable(rows: BoardRow[]): {
  attention: BoardRow[];
  tasks: BoardRow[];
  review: BoardRow[];
  merge: BoardRow[];
  parents: BoardRow[];
} {
  const attention: BoardRow[] = [];
  const review: BoardRow[] = [];
  const merge: BoardRow[] = [];
  const tasks: BoardRow[] = [];
  const parents: BoardRow[] = [];
  for (const r of rows) {
    // A keyless row (an event from an old hook build that lost its branch) has
    // no ticket to open or clear; showing it would pin a blank row on top.
    if (!r.key) continue;
    if (isParentRow(r)) parents.push(r);
    else if (needsAttention(r)) attention.push(r);
    else if (r.section === "review") review.push(r);
    else if (r.section === "merge") merge.push(r);
    else tasks.push(r);
  }
  return { attention, tasks, review, merge, parents };
}

export type ReviewEntry = { row: BoardRow; reason: string };

// Sort the review rows by the fetched order, reasons attached. A null order
// (still fetching) and any row the order missed keep board order with a "…"
// placeholder, so the section is usable before the AI order lands.
export function applyOrder(review: BoardRow[], order: OrderEntry[] | null): ReviewEntry[] {
  const reasonByPr = new Map((order ?? []).map((e) => [e.pr, e.reason]));
  const rank = new Map((order ?? []).map((e, i) => [e.pr, i]));
  const ordered: ReviewEntry[] = [];
  const unranked: ReviewEntry[] = [];
  for (const row of review) {
    const r = row.pr != null ? rank.get(row.pr) : undefined;
    const entry = { row, reason: row.pr != null ? (reasonByPr.get(row.pr) ?? "…") : "…" };
    if (r !== undefined) ordered.push(entry);
    else unranked.push(entry);
  }
  ordered.sort((a, b) => rank.get(a.row.pr!)! - rank.get(b.row.pr!)!);
  return [...ordered, ...unranked];
}

// One header for all four panes, in one order, so a row reads the same
// wherever it sits.
function reasonCell(r: BoardRow): string {
  const reasons = r.stuckReason ? [...r.flagReasons, r.stuckReason] : r.flagReasons;
  if (reasons.length > 0) return `{red-fg}${reasons.join(",")}{/red-fg}`;
  return waitText(r);
}

function waitText(r: BoardRow): string {
  if (!r.waitingOn?.length) return "";
  const prs = r.waitingOn.map((n) => `#${n}`).join(", ");
  if (r.waitingKind === "overlap") return `held behind ${prs} (${["same files", r.waitingNote].filter(Boolean).join(", ")})`;
  return `waiting on ${prs} to land${r.waitingNote ? ` (${r.waitingNote})` : ""}`;
}

export const BOARD_HEADER = ["DUR", "STATUS", "TYPE", "TICKET", "PR", "REPO", "TITLE", "FLAG", "REASON"];

export const PR_COLUMN = BOARD_HEADER.indexOf("PR");

const STATUS_COLOR: Record<string, string> = {
  working: "cyan",
  "addressing review": "cyan",
  "fixing CI": "cyan",
  "resolving conflict": "cyan",
  unblocking: "cyan",
  refining: "cyan",
  "self-improving": "cyan",
  stuck: "red",
  "CI failing": "red",
  "merge queue blocked": "red",
  "unresolved threads": "red",
  "needs decision": "red",
  "review findings": "yellow",
  "awaiting approval": "yellow",
  "needs approval": "yellow",
  "changes requested": "red",
  "ready to merge": "green",
  "ready: r to queue": "green",
  "ready: merge manually": "green",
  "draft pr": "green",
  "waiting on slices": "yellow",
  "fix done": "yellow",
  "tracker ticket": "yellow",
};

function typeCell(r: BoardRow, words: string[]): string {
  const type = rowType(r, words);
  if (r.terminal) return grey(type ?? "code");
  if (!type) return "code";
  const color = TYPE_CHIP_COLOR[type];
  return `{${color}-fg}${type}{/${color}-fg}`;
}

function statusCell(row: Pick<BoardRow, "status" | "terminal">): string {
  if (row.terminal) return grey(row.status);
  const color = STATUS_COLOR[row.status];
  return color ? `{${color}-fg}${row.status}{/${color}-fg}` : row.status;
}

export function boardTable(
  entries: { row: BoardRow }[],
  now: number = Date.now(),
  codebaseName: string = codebaseRepoName(),
  words: string[] = researchWords(),
): string[][] {
  const body = entries.map(({ row: r }) => {
    const durMs = r.terminal ? r.ts - r.startTs : now - r.startTs;
    return [
      dimWhenDone(r.terminal, fmtDuration(durMs)),
      statusCell(r),
      typeCell(r, words),
      r.label,
      r.pr != null ? `#${r.pr}` : "",
      dimWhenDone(r.terminal, repoDisplayName(r, codebaseName)),
      r.title ?? "",
      isFlagged(r) ? "{red-fg}⚑{/red-fg}" : "",
      reasonCell(r),
    ];
  });
  return [BOARD_HEADER, ...body];
}

// blessed sizes each table's columns from that table's own rows, so three panes
// sharing a header still land on three different grids. Pad every cell out to
// the widest cell in its column across ALL the tables and each pane computes the
// same maxes, which is what puts the columns on the same offsets. An empty pane
// still has its header row, so it lines up too.
export function alignTables(tables: string[][][]): string[][][] {
  const widths: number[] = [];
  for (const table of tables) {
    for (const row of table) {
      row.forEach((cell, i) => {
        widths[i] = Math.max(widths[i] ?? 0, cellWidth(cell));
      });
    }
  }
  return tables.map((table) =>
    table.map((row) => row.map((cell, i) => cell + " ".repeat((widths[i] ?? 0) - cellWidth(cell)))),
  );
}

// Which column a listtable's inner x offset lands on, from its _maxes. Each
// column is its width plus the one space blessed puts after it; -1 is past the
// last column.
export function columnAt(maxes: number[], x: number): number {
  if (x < 0) return -1;
  let start = 0;
  for (let i = 0; i < maxes.length; i++) {
    start += maxes[i] + 1;
    if (x < start) return i;
  }
  return -1;
}

export type TableBoxes = {
  attention: { top: number; left: number; right: number; height: number };
  tasks: { top: number; left: number; right: number; bottom: number };
  review: { left: number; right: number; bottom: number; height: number };
  merge: { left: number; right: number; bottom: number; height: number };
};

// Four full-width bordered panes stacked top to bottom: needs attention, tasks,
// ready to review, ready to merge. Each keeps an equal quarter of the body
// (tasks takes the remainder) whether or not it has rows, so the panes never
// jump around as rows move between them. The parents box sits in the queue's column, so it
// does not take height from these panes.
export function tableBoxes(screenHeight: number, screenWidth: number): TableBoxes {
  const footerRows = 1;
  const titleRows = 1;
  const body = screenHeight - titleRows - footerRows;
  const quarter = Math.max(PANE_MIN_HEIGHT, Math.floor(body / 4));
  const inset = screenWidth >= QUEUE_MIN_SCREEN_WIDTH ? QUEUE_PANE_WIDTH : 0;
  return {
    attention: { top: titleRows, left: inset, right: 0, height: quarter },
    tasks: { top: titleRows + quarter, left: inset, right: 0, bottom: footerRows + 2 * quarter },
    review: { left: inset, right: 0, bottom: footerRows + quarter, height: quarter },
    merge: { left: inset, right: 0, bottom: footerRows, height: quarter },
  };
}

export function tableFocusOrder(counts: Record<TableId, number>, hasParents: boolean): string[] {
  const order: string[] = TABLE_IDS.filter((id) => counts[id] > 0);
  if (hasParents) order.push("parents");
  return order;
}
