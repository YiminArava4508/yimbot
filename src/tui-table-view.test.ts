import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import blessed from "neo-blessed";
import type { BoardRow } from "./events.ts";
import { BOARD_HEADER, tableBoxes } from "./table-view.ts";
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

function setup(counts = { attention: 0, tasks: 2, review: 2, merge: 2 }, focusedId = "tasks") {
  const screen = testScreen();
  const opened: BoardRow[] = [];
  const focused: string[] = [];
  const view = createTableView({
    parent: screen,
    onFocus: (id) => focused.push(id),
    onOpen: (r) => opened.push(r),
    onOpenPr: () => {},
  });
  const input: TableViewInput = {
    attention: rows("A", counts.attention),
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

test("render fills the four panes and labels them with counts", () => {
  const { view } = setup({ attention: 1, tasks: 3, review: 2, merge: 1 });
  assert.equal(view.widgets.attention._label.content, " needs attention 1 ");
  assert.equal(view.widgets.attention.rows.length, 2);
  assert.equal(view.widgets.tasks._label.content, " \u25b6 in progress 3 \u25c0 ");
  assert.equal(view.widgets.review._label.content, " ready to review 2 ");
  assert.equal(view.widgets.merge._label.content, " ready to merge 1 ");
  assert.equal(view.widgets.tasks.rows.length, 4);
  assert.equal(view.widgets.review.rows.length, 3);
  assert.equal(view.widgets.merge.rows.length, 2);
});

test("every pane keeps its color and thin frame; only the focused one gets arrows in its title and an inverse row", () => {
  const { view, input } = setup({ attention: 1, tasks: 2, review: 2, merge: 2 });
  const colors = { attention: "red", tasks: "grey", review: "yellow", merge: "green" } as const;
  for (const focusedId of ["attention", "tasks", "review", "merge"] as const) {
    view.render({ ...input, focusedId });
    for (const id of ["attention", "tasks", "review", "merge"] as const) {
      const w = view.widgets[id];
      const focused = id === focusedId;
      assert.equal(w.style.border.fg, colors[id], `${id} border color with ${focusedId} focused`);
      assert.equal(w.style.label.fg, colors[id]);
      assert.equal(w.border.type, "line");
      assert.equal(w.style.bg, undefined);
      assert.equal(w._label.content.includes("\u25b6"), focused, `${id} arrows with ${focusedId} focused`);
      assert.equal(w.style.selected.inverse, focused);
    }
  }
});

test("only the focused pane drops tag colors on its selected row", () => {
  const { view, input } = setup();
  assert.notEqual(view.widgets.tasks.options.invertSelected, false);
  assert.equal(view.widgets.review.options.invertSelected, false);
  view.render({ ...input, focusedId: "review" });
  assert.equal(view.widgets.tasks.options.invertSelected, false);
  assert.notEqual(view.widgets.review.options.invertSelected, false);
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

test("empty panes stay visible with their zero-count label", () => {
  const { view, input } = setup({ attention: 0, tasks: 0, review: 0, merge: 0 });
  for (const id of ["tasks", "review", "merge"] as const) assert.equal(view.widgets[id].hidden, false);
  assert.equal(view.widgets.review._label.content, " ready to review 0 ");
  view.hide();
  view.show();
  assert.equal(view.widgets.review.hidden, false);
  view.render(input);
  assert.equal(view.widgets.merge.hidden, false);
});

test("hiding or emptying the focused pane does not report a focus", () => {
  const { view, input, focused } = setup();
  // Two panes in the focus history, so hiding the focused one rewinds onto
  // the other and would report it without the guard.
  view.widgets.review.focus();
  view.widgets.tasks.focus();
  focused.length = 0;
  view.hide();
  assert.deepEqual(focused, []);
  view.show();
  view.widgets.review.focus();
  focused.length = 0;
  view.render({ ...input, review: [] });
  view.hide();
  assert.deepEqual(focused, []);
});

test("a fresh view keeps its panes hidden until the first render", () => {
  const screen = testScreen();
  const view = createTableView({ parent: screen, onFocus: () => {}, onOpen: () => {}, onOpenPr: () => {} });
  for (const id of ["attention", "tasks", "review", "merge"] as const) assert.equal(view.widgets[id].hidden, true);
  view.render({ attention: [], tasks: [], review: [], merge: [], now: 0, boxes: tableBoxes(30, 100), focusedId: "tasks" });
  for (const id of ["attention", "tasks", "review", "merge"] as const) assert.equal(view.widgets[id].hidden, false);
});

test("the tasks pane stretches from the title to the review pane", () => {
  const { view } = setup();
  const boxes = tableBoxes(30, 100);
  assert.equal(view.widgets.tasks.height, 30 - boxes.tasks.top - boxes.tasks.bottom);
});

function clickCell(view: ReturnType<typeof createTableView>, id: "tasks" | "review" | "merge", rowIndex: number, column: string) {
  const pane = view.widgets[id];
  const item = pane.items[rowIndex + 1];
  const colIdx = BOARD_HEADER.indexOf(column);
  const offset = pane._maxes.slice(0, colIdx).reduce((sum: number, w: number) => sum + w + 1, 0);
  const data = { x: pane.aleft + pane.ileft + offset, y: item.atop };
  item.emit("mousedown", { ...data, action: "mousedown" });
  item.emit("click", { ...data, action: "mouseup" });
}

function prSetup() {
  const screen = testScreen();
  const opened: BoardRow[] = [];
  const openedPrs: BoardRow[] = [];
  const view = createTableView({
    parent: screen,
    onFocus: () => {},
    onOpen: (r) => opened.push(r),
    onOpenPr: (r) => openedPrs.push(r),
  });
  const input: TableViewInput = {
    attention: [],
    tasks: [{ ...row("T-0"), pr: 41 }, row("T-1")],
    review: [],
    merge: [],
    now: 0,
    boxes: tableBoxes(30, 100),
    focusedId: "tasks",
  };
  view.render(input);
  screen.render();
  return { view, opened, openedPrs };
}

test("a click on the PR cell opens that PR and not the session, even on the selected row", () => {
  const { view, opened, openedPrs } = prSetup();
  view.widgets.tasks.select(1);
  clickCell(view, "tasks", 0, "PR");
  assert.deepEqual(openedPrs.map((r) => r.pr), [41]);
  assert.deepEqual(opened, []);
});

test("a click on a blank PR cell opens nothing", () => {
  const { view, opened, openedPrs } = prSetup();
  clickCell(view, "tasks", 1, "PR");
  assert.deepEqual(openedPrs, []);
  assert.deepEqual(opened, []);
});

test("a click elsewhere on the selected row still opens its session", () => {
  const { view, opened, openedPrs } = prSetup();
  view.widgets.tasks.select(1);
  clickCell(view, "tasks", 0, "TITLE");
  assert.deepEqual(opened.map((r) => r.key), ["T-0"]);
  assert.deepEqual(openedPrs, []);
});
