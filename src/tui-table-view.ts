import blessed from "neo-blessed";
import { FOCUS_BORDER } from "./arch-layout.ts";
import { paneLabel } from "./board-format.ts";
import type { BoardRow } from "./events.ts";
import { alignTables, boardTable, type ReviewEntry, type TableBoxes, type TableId } from "./table-view.ts";

export type TableViewInput = {
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
  selectedRow(id: TableId, input: Pick<TableViewInput, "tasks" | "review" | "merge">): BoardRow | undefined;
  show(): void;
  hide(): void;
};

const TABLE_IDS: readonly TableId[] = ["tasks", "review", "merge"];

const TABLE_BORDER: Record<TableId, string> = { tasks: "grey", review: "yellow", merge: "green" };

const TABLE_TITLE: Record<TableId, string> = {
  tasks: "in progress",
  review: "ready to review",
  merge: "ready to merge",
};

export function createTableView(opts: {
  parent: any;
  onFocus: (id: TableId) => void;
  onOpen: (row: BoardRow) => void;
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
    tasks: makePane("tasks", { top: 1 }),
    review: makePane("review", { height: 4 }),
    merge: makePane("merge", { height: 4 }),
  };
  const counts: Record<TableId, number> = { tasks: 0, review: 0, merge: 0 };
  let last: Pick<TableViewInput, "tasks" | "review" | "merge"> = { tasks: [], review: [], merge: [] };
  let visible = true;
  let syncing = false;

  const selectedRow: TableView["selectedRow"] = (id, input) => {
    const index = widgets[id].selected - 1;
    if (id === "review") return input.review[index]?.row;
    return input[id][index];
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
      const picked = selectedRow(id, last);
      if (picked) opts.onOpen(picked);
    });
  }

  return {
    widgets,
    selectedRow,
    render(input) {
      last = input;
      counts.tasks = input.tasks.length;
      counts.review = input.review.length;
      counts.merge = input.merge.length;
      const [tasksData, reviewData, mergeData] = alignTables([
        boardTable(input.tasks.map((row) => ({ row })), input.now),
        boardTable(input.review.map((e) => ({ row: e.row })), input.now),
        boardTable(input.merge.map((row) => ({ row })), input.now),
      ]);
      const { boxes } = input;
      Object.assign(widgets.tasks, boxes.tasks);
      Object.assign(widgets.review, boxes.review);
      Object.assign(widgets.merge, boxes.merge);
      const data = { tasks: tasksData, review: reviewData, merge: mergeData };
      for (const id of TABLE_IDS) {
        widgets[id].setLabel(paneLabel(TABLE_TITLE[id], counts[id]));
        widgets[id].setData(data[id]);
        const fg = id === input.focusedId ? FOCUS_BORDER : TABLE_BORDER[id];
        widgets[id].style.border.fg = fg;
        widgets[id].style.label.fg = fg;
        // neo-blessed aliases style.selected to style.cell.selected on a
        // listtable and resolves it at paint time, so mutating it is enough.
        widgets[id].style.selected.inverse = id === input.focusedId;
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
