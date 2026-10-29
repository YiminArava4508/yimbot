import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import blessed from "neo-blessed";
import { FOCUS_BORDER } from "./arch-layout.ts";
import type { BoardRow } from "./events.ts";
import { tableBoxes } from "./table-view.ts";
import { createTableView, type TableViewInput } from "./tui-table-view.ts";

function fakeTty(columns: number, rows: number) {
  class FakeStream extends EventEmitter {
    columns = columns;
    rows = rows;
    isTTY = true;
    writable = true;
    write() {
      return true;
    }
    setRawMode() {}
    pause() {}
    resume() {}
    ref() {}
    unref() {}
    end() {}
  }
  return { input: new FakeStream(), output: new FakeStream() };
}

function testScreen(rows = 30) {
  const { input, output } = fakeTty(100, rows);
  return blessed.screen({ input, output, terminal: "xterm", smartCSR: true, fullUnicode: true });
}

const row = (key: string): BoardRow => ({
  key,
  label: key,
  status: "working",
  terminal: false,
  section: "tasks",
  ts: 0,
  startTs: 0,
  flagged: false,
  flagReasons: [],
});

const rows = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => row(`${prefix}-${i}`));

function setup(counts = { tasks: 2, review: 2, merge: 2 }, focusedId = "tasks") {
  const screen = testScreen();
  const opened: BoardRow[] = [];
  const focused: string[] = [];
  const view = createTableView({
    parent: screen,
    onFocus: (id) => focused.push(id),
    onOpen: (r) => opened.push(r),
  });
  const input: TableViewInput = {
    tasks: rows("T", counts.tasks),
    review: rows("R", counts.review).map((r) => ({ row: r, reason: "" })),
    merge: rows("M", counts.merge),
    now: 0,
    boxes: tableBoxes(30, 100),
    focusedId,
  };
  view.render(input);
  screen.render();
  return { screen, view, input, opened, focused };
}

test("render fills the three panes and labels them with counts", () => {
  const { view } = setup({ tasks: 3, review: 2, merge: 1 });
  assert.equal(view.widgets.tasks._label.content, " in progress 3 ");
  assert.equal(view.widgets.review._label.content, " ready to review 2 ");
  assert.equal(view.widgets.merge._label.content, " ready to merge 1 ");
  assert.equal(view.widgets.tasks.rows.length, 4);
  assert.equal(view.widgets.review.rows.length, 3);
  assert.equal(view.widgets.merge.rows.length, 2);
});

test("the focused pane takes the focus color and only it inverses its selected row", () => {
  const { view, input } = setup();
  assert.equal(view.widgets.tasks.style.border.fg, FOCUS_BORDER);
  assert.equal(view.widgets.tasks.style.label.fg, FOCUS_BORDER);
  assert.equal(view.widgets.tasks.style.selected.inverse, true);
  assert.equal(view.widgets.review.style.border.fg, "yellow");
  assert.equal(view.widgets.merge.style.border.fg, "green");
  assert.equal(view.widgets.review.style.selected.inverse, false);
  view.render({ ...input, focusedId: "review" });
  assert.equal(view.widgets.tasks.style.border.fg, "grey");
  assert.equal(view.widgets.review.style.border.fg, FOCUS_BORDER);
  assert.equal(view.widgets.tasks.style.selected.inverse, false);
  assert.equal(view.widgets.review.style.selected.inverse, true);
});

test("selectedRow reads each pane's selection (review through the entries)", () => {
  const { view, input } = setup();
  view.widgets.tasks.select(2);
  view.widgets.review.select(2);
  view.widgets.merge.select(1);
  assert.equal(view.selectedRow("tasks", input)?.key, "T-1");
  assert.equal(view.selectedRow("review", input)?.key, "R-1");
  assert.equal(view.selectedRow("merge", input)?.key, "M-0");
});

test("enter on a pane calls onOpen with that row", () => {
  const { screen, view, opened } = setup();
  view.widgets.review.focus();
  view.widgets.review.select(2);
  screen.focused.emit("keypress", "", { name: "enter", full: "enter" });
  assert.deepEqual(opened.map((r) => r.key), ["R-1"]);
});

test("a widget focus event reports the pane id", () => {
  const { view, focused } = setup();
  view.widgets.merge.emit("focus");
  assert.deepEqual(focused, ["merge"]);
});

test("hide and show toggle all three panes", () => {
  const { view } = setup();
  view.hide();
  for (const id of ["tasks", "review", "merge"] as const) assert.equal(view.widgets[id].hidden, true);
  view.show();
  for (const id of ["tasks", "review", "merge"] as const) assert.equal(view.widgets[id].hidden, false);
});

test("empty review and merge panes are hidden, tasks always shows", () => {
  const { view, input } = setup({ tasks: 0, review: 0, merge: 0 });
  assert.equal(view.widgets.tasks.hidden, false);
  assert.equal(view.widgets.review.hidden, true);
  assert.equal(view.widgets.merge.hidden, true);
  view.render({ ...input, review: [{ row: row("R-0"), reason: "" }] });
  assert.equal(view.widgets.review.hidden, false);
});
