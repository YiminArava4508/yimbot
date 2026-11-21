import blessed from "neo-blessed";
import { paneLabel } from "./board-format.ts";
import type { BoardRow } from "./events.ts";
import { PR_COLUMN, TABLE_IDS, alignTables, boardTable, columnAt, type ReviewEntry, type TableBoxes, type TableId } from "./table-view.ts";

export type TableViewInput = {
  attention: BoardRow[];
  tasks: BoardRow[];
  review: ReviewEntry[];
  merge: BoardRow[];
  now: number;
  boxes: TableBoxes;
  focusedId: string;
};

export type TableView = {
  widgets: Record<TableId, any>;
  render(input: TableViewInput): void;
  selectedRow(id: TableId, input: Pick<TableViewInput, TableId>): BoardRow | undefined;
  show(): void;
  hide(): void;
};

const TABLE_BORDER: Record<TableId, string> = { attention: "red", tasks: "grey", review: "yellow", merge: "green" };

const TABLE_TITLE: Record<TableId, string> = {
  attention: "needs attention",
  tasks: "in progress",
  review: "ready to review",
  merge: "ready to merge",
};

export function createTableView(opts: {
  parent: any;
  onFocus: (id: TableId) => void;
  onOpen: (row: BoardRow) => void;
  onOpenPr: (row: BoardRow) => void;
}): TableView {
  // Positions are re-fit by render() from tableBoxes; tasks is sized by its
  // top and bottom, so it must not start with a height that would win.
  const makePane = (id: TableId, position: Record<string, number>) =>
    blessed.listtable({
      parent: opts.parent,
      left: 0,
      right: 0,
      bottom: 1,
      ...position,
      hidden: true,
      tags: true,
      align: "left",
      keys: true,
      vi: true,
      mouse: true,
      border: { type: "line" },
      // A bordered listtable defaults to drawing cell borders between every
      // column, which turns the pane into a full grid; keep the flat look.
      noCellBorders: true,
      style: {
        header: { bold: true },
        cell: { selected: { inverse: true } },
        border: { fg: TABLE_BORDER[id] },
        label: { fg: TABLE_BORDER[id] },
      },
    });

  const widgets: Record<TableId, any> = {
    attention: makePane("attention", { top: 1, height: 4 }),
    tasks: makePane("tasks", { top: 5 }),
    review: makePane("review", { height: 4 }),
    merge: makePane("merge", { height: 4 }),
  };
  const counts: Record<TableId, number> = { attention: 0, tasks: 0, review: 0, merge: 0 };
  let last: Pick<TableViewInput, TableId> = { attention: [], tasks: [], review: [], merge: [] };
  let visible = true;
  let syncing = false;
  // The row whose PR cell the current click went down on. blessed fires the
  // list's select (which opens the session) before the click reaches the pane,
  // so mousedown is the only point early enough to claim the click for the PR.
  let prClick: BoardRow | undefined;

  const selectedRow: TableView["selectedRow"] = (id, input) => {
    const index = widgets[id].selected - 1;
    if (id === "review") return input.review[index]?.row;
    return input[id][index];
  };

  const rowAtItem = (id: TableId, item: any): BoardRow | undefined => {
    const index = widgets[id].items.indexOf(item) - 1;
    if (index < 0) return undefined;
    if (id === "review") return last.review[index]?.row;
    return last[id][index];
  };

  const prCellRow = (id: TableId, item: any, x: number): BoardRow | undefined => {
    const pane = widgets[id];
    if (!pane._maxes || columnAt(pane._maxes, x - pane.aleft - pane.ileft) !== PR_COLUMN) return undefined;
    const row = rowAtItem(id, item);
    return row?.pr != null ? row : undefined;
  };

  const syncVisibility = () => {
    // Hiding a focused widget makes blessed rewind focus onto another one;
    // that focus event is ours, not the operator's.
    syncing = true;
    try {
      for (const id of TABLE_IDS) {
        if (visible) widgets[id].show();
        else widgets[id].hide();
      }
    } finally {
      syncing = false;
    }
  };

  for (const id of TABLE_IDS) {
    widgets[id].on("focus", () => {
      if (!syncing) opts.onFocus(id);
    });
    widgets[id].on("select", () => {
      if (prClick) return;
      const picked = selectedRow(id, last);
      if (picked) opts.onOpen(picked);
    });
    widgets[id].on("element mousedown", (el: any, data: { x: number }) => {
      prClick = prCellRow(id, el, data.x);
    });
    widgets[id].on("element click", () => {
      const row = prClick;
      prClick = undefined;
      if (row) opts.onOpenPr(row);
    });
  }

  return {
    widgets,
    selectedRow,
    render(input) {
      last = input;
      counts.attention = input.attention.length;
      counts.tasks = input.tasks.length;
      counts.review = input.review.length;
      counts.merge = input.merge.length;
      const [attentionData, tasksData, reviewData, mergeData] = alignTables([
        boardTable(input.attention.map((row) => ({ row })), input.now),
        boardTable(input.tasks.map((row) => ({ row })), input.now),
        boardTable(input.review.map((e) => ({ row: e.row })), input.now),
        boardTable(input.merge.map((row) => ({ row })), input.now),
      ]);
      const { boxes } = input;
      Object.assign(widgets.attention, boxes.attention);
      Object.assign(widgets.tasks, boxes.tasks);
      Object.assign(widgets.review, boxes.review);
      Object.assign(widgets.merge, boxes.merge);
      const data = { attention: attentionData, tasks: tasksData, review: reviewData, merge: mergeData };
      for (const id of TABLE_IDS) {
        widgets[id].setLabel(paneLabel(TABLE_TITLE[id], counts[id], id === input.focusedId));
        widgets[id].setData(data[id]);
        // neo-blessed aliases style.selected to style.cell.selected on a
        // listtable and resolves it at paint time, so mutating it is enough.
        widgets[id].style.selected.inverse = id === input.focusedId;
        // neo-blessed strips foreground tags from a list's selected row unless
        // invertSelected is false; only the focused pane's inverse row wants that.
        widgets[id].options.invertSelected = id === input.focusedId;
      }
      syncVisibility();
    },
    show() {
      visible = true;
      syncVisibility();
    },
    hide() {
      visible = false;
      syncVisibility();
    },
  };
}
