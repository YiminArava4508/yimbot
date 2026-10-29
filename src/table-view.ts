import { cellWidth, codebaseRepoName, fmtDuration, fmtTime, grey, repoDisplayName, titleCell } from "./board-format.ts";
import { isFlagged, isParentRow, type BoardRow } from "./events.ts";
import { QUEUE_PANE_WIDTH } from "./heavy-queue.ts";
import type { OrderEntry } from "./review-order.ts";
import { researchWords } from "./ticket-type.ts";

export type TableId = "tasks" | "review" | "merge";

// Below this the board's nine columns no longer fit beside the queue, so the
// queue gives way rather than squeezing the rows it exists to annotate.
export const QUEUE_MIN_SCREEN_WIDTH = 80;

// Header row plus the two border rows; a pane needs one more to show a row.
export const PANE_CHROME_ROWS = 3;
export const PANE_MIN_HEIGHT = PANE_CHROME_ROWS + 1;

// Placement reads the row's section, never its status. The daemon reports the
// section each heartbeat from the facts that actually decide it (the ready
// label, the draft flag), so a queued PR stays in the merge pane while its
// status walks through a CI fix, a conflict fix or a review round. A row only
// moves when the label does. The one exception is the split parents: the
// daemon only ever gives that status to a split's tracking ticket, and it
// outranks whatever section the key's own PR left behind before the split, so
// they leave the work panes for their own.
export function partitionTable(rows: BoardRow[]): {
  tasks: BoardRow[];
  review: BoardRow[];
  merge: BoardRow[];
  parents: BoardRow[];
} {
  const review: BoardRow[] = [];
  const merge: BoardRow[] = [];
  const tasks: BoardRow[] = [];
  const parents: BoardRow[] = [];
  for (const r of rows) {
    if (isParentRow(r)) parents.push(r);
    else if (r.section === "review") review.push(r);
    else if (r.section === "merge") merge.push(r);
    else tasks.push(r);
  }
  return { tasks, review, merge, parents };
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

// One header for all three panes, in one order, so a row reads the same
// wherever it sits.
export const BOARD_HEADER = ["TIME", "DUR", "STATUS", "TICKET", "PR", "REPO", "TITLE", "FLAG", "REASON"];

export function boardTable(
  entries: { row: BoardRow }[],
  now: number = Date.now(),
  codebaseName: string = codebaseRepoName(),
  words: string[] = researchWords(),
): string[][] {
  const body = entries.map(({ row: r }) => {
    const durMs = r.terminal ? r.ts - r.startTs : now - r.startTs;
    return [
      grey(fmtTime(r.ts)),
      grey(fmtDuration(durMs)),
      r.terminal ? grey(r.status) : r.status,
      r.label,
      r.pr != null ? `#${r.pr}` : "",
      grey(repoDisplayName(r, codebaseName)),
      titleCell(r, words),
      isFlagged(r) ? "{red-fg}⚑{/red-fg}" : "",
      r.flagReasons.length > 0 ? `{red-fg}${r.flagReasons.join(",")}{/red-fg}` : "",
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

export type TableBoxes = {
  tasks: { top: number; left: number; right: number; bottom: number };
  review: { left: number; right: number; bottom: number; height: number };
  merge: { left: number; right: number; bottom: number; height: number };
};

// Three full-width bordered panes stacked top to bottom: tasks, ready to
// review, ready to merge. Each keeps an equal third of the body (tasks takes
// the remainder) whether or not it has rows, so the panes never jump around as
// PRs move between them. The parents box sits in the queue's column, so it
// does not take height from these panes.
export function tableBoxes(screenHeight: number, screenWidth: number, _parentsHeight: number): TableBoxes {
  const footerRows = 1;
  const titleRows = 1;
  const body = screenHeight - titleRows - footerRows;
  const third = Math.max(PANE_MIN_HEIGHT, Math.floor(body / 3));
  const inset = screenWidth >= QUEUE_MIN_SCREEN_WIDTH ? QUEUE_PANE_WIDTH : 0;
  return {
    tasks: { top: titleRows, left: inset, right: 0, bottom: footerRows + 2 * third },
    review: { left: inset, right: 0, bottom: footerRows + third, height: third },
    merge: { left: inset, right: 0, bottom: footerRows, height: third },
  };
}

export function tableFocusOrder(counts: Record<TableId, number>, hasParents: boolean): string[] {
  const order: string[] = (["tasks", "review", "merge"] as const).filter((id) => counts[id] > 0);
  if (hasParents) order.push("parents");
  return order;
}
