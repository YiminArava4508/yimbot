import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import blessed from "neo-blessed";
import { TABLE_IDS, isTableId } from "./table-view.ts";
import { DEFAULT_VIEW, bindColumnKeys, makeSelectGuard, bindViewKey, headerBoard, nextView, onlyInView, tableSections, viewFocus, viewFocusOrder, latestOnly, bindFlagKey, bindModeKey, hidePanesKeepingFocus, onPaneFocusChange, bindHelpKey, bindPaneNavKeys, bindPaneToggle, bindQuitKeys, bindReadyKey, bindReviewKey, bindSettingsKey, boardLayout, cellWidth, fmtDuration, footerHint, footerLayout, grey, handleReadyPress, headerInset, statusLayout, titleLayout, helpLines, modeContent, paneLabel, placeColumns, prActionRefusal, resolveFocus, rowForAction, styleParentsPane, titleContent, parentRows, returnKey, reachWarnings, screenTerm, statusContent } from "./tui.ts";
import { stepFocus, type Card, type Column } from "./kanban.ts";
import { FOCUS_BORDER } from "./arch-layout.ts";
import type { BoardRow } from "./events.ts";
import { QUEUE_PANE_WIDTH } from "./heavy-queue.ts";

const row = (over: Partial<BoardRow>): BoardRow => ({
  key: "ENG-1",
  label: "ENG-1",
  status: "working",
  terminal: false,
  section: "tasks",
  ts: 0,
  startTs: 0,
  flagged: false,
  flagReasons: [],
  ...over,
});

test("fmtDuration formats seconds, minutes, and hours", () => {
  assert.equal(fmtDuration(45_000), "45s");
  assert.equal(fmtDuration(18 * 60_000), "18m");
  assert.equal(fmtDuration((6 * 60 + 40) * 60_000), "6h 40m");
  assert.equal(fmtDuration(6 * 60 * 60_000), "6h");
});

test("returnKey defaults to Y", () => {
  const prev = process.env.TUI_RETURN_KEY;
  delete process.env.TUI_RETURN_KEY;
  try {
    assert.equal(returnKey(), "Y");
  } finally {
    if (prev === undefined) delete process.env.TUI_RETURN_KEY;
    else process.env.TUI_RETURN_KEY = prev;
  }
});

test("returnKey honors TUI_RETURN_KEY and falls back when it is blank", () => {
  const prev = process.env.TUI_RETURN_KEY;
  try {
    process.env.TUI_RETURN_KEY = "F12";
    assert.equal(returnKey(), "F12");
    process.env.TUI_RETURN_KEY = "   ";
    assert.equal(returnKey(), "Y");
  } finally {
    if (prev === undefined) delete process.env.TUI_RETURN_KEY;
    else process.env.TUI_RETURN_KEY = prev;
  }
});

test("footerHint is a lean legend: help and quit everywhere, the rest lives under ?", () => {
  const hint = footerHint();
  assert.match(hint, /\? help/);
  assert.match(hint, /\^c quit/);
  assert.doesNotMatch(hint, /\bq quit/);
  assert.doesNotMatch(hint, /j\/k move|f flag|m mode|s settings|returns here|tab pane/);
});

test("footerHint shows r/R: r reaches an unlabeled row wherever it sits", () => {
  assert.match(footerHint(), /r ready {3}R review/);
});

test("helpLines carries every keybind the footer no longer shows", () => {
  const text = helpLines("F12").join("\n");
  for (const needle of [
    "j/k", "^j/^k", "tab", "enter", "f", "r", "R", "m", "s", "v", "h/l", "?", "^c", "prefix+F12",
  ]) {
    assert.ok(text.includes(needle), `help must mention ${needle}`);
  }
  assert.doesNotMatch(text, /review pane/);
  assert.match(text, /switch pane \(tab cycles\)/);
  assert.doesNotMatch(text, /card/, "the default table view has rows, not cards");
  assert.match(text, /flag\/unflag the selected row/);
  assert.doesNotMatch(text, /\{bold\}q\s*\{\/bold\}/, "q is no longer a quit key");
});

test("bindHelpKey opens only when no overlay is open", () => {
  const handlers: Record<string, () => void> = {};
  const screen = { key: (keys: string[], fn: () => void) => { for (const k of keys) handlers[k] = fn; } };
  let opened = 0;
  let overlay = false;
  bindHelpKey(screen, () => overlay, () => { opened++; });
  handlers["?"]();
  assert.equal(opened, 1);
  overlay = true;
  handlers["?"]();
  assert.equal(opened, 1);
});

test("modeContent highlights each mode distinctly", () => {
  assert.equal(modeContent("supervised"), "{black-fg}{yellow-bg} SUPERVISED {/yellow-bg}{/black-fg}");
  assert.equal(modeContent("autonomous"), "{black-fg}{green-bg} AUTONOMOUS {/green-bg}{/black-fg}");
});

test("bindModeKey gates m while settings is open", () => {
  const handlers: Record<string, () => void> = {};
  const fakeScreen = {
    key: (keys: string[], fn: () => void) => {
      for (const k of keys) handlers[k] = fn;
    },
  };
  let settingsOpen = true;
  let toggleCalls = 0;
  bindModeKey(fakeScreen, () => settingsOpen, () => toggleCalls++);

  handlers["m"]();
  assert.equal(toggleCalls, 0, "m must not toggle the mode while the panel is open");

  settingsOpen = false;
  handlers["m"]();
  assert.equal(toggleCalls, 1, "m toggles again once the panel is closed");
});

test("the settings key moved to the help overlay", () => {
  assert.doesNotMatch(footerHint(), /s settings/);
  assert.match(helpLines("Y").join("\n"), /settings/);
});

test("footerHint no longer advertises a refine key (refine lives in settings)", () => {
  assert.doesNotMatch(footerHint(), /refine/);
});

test("statusContent is the mode chip alone: no refine, split or activity text", () => {
  const bar = statusContent("supervised", null, 0, []);
  assert.equal(bar, modeContent("supervised"));
  assert.doesNotMatch(bar, /REFINE|SPLIT|live|active/);
});

test("paneLabel is the plain pane name and its count", () => {
  assert.equal(paneLabel("tasks", 3), " tasks 3 ");
});

test("titleContent is the plain cyan wordmark until a board arrives", () => {
  assert.equal(titleContent(null), "{cyan-fg}{bold}yimbot{/bold}{/cyan-fg}");
});

test("titleContent appends the cycle number in grey", () => {
  assert.equal(titleContent({ cycleNumber: 42 }), `{cyan-fg}{bold}yimbot{/bold}{/cyan-fg}${grey(" cycle 42")}`);
});

test("titleContent says no active cycle in grey when the team has none", () => {
  assert.equal(titleContent({ cycleNumber: null }), `{cyan-fg}{bold}yimbot{/bold}{/cyan-fg}${grey(" no active cycle")}`);
});

const card = (over: Partial<Card>): Card => ({ key: "ENG-1", title: "t", stateName: "Todo", row: null, ...over });

test("rowForAction hands back the card's yimbot row", () => {
  const r = row({ key: "ENG-1" });
  assert.deepEqual(rowForAction(card({ row: r })), { row: r });
});

test("prActionRefusal refuses r and R on a parent card whatever its section or PR", () => {
  const parent = row({ status: "waiting on slices", section: "merge", pr: 7 });
  assert.equal(prActionRefusal(parent), "{red-fg}parent tickets have no PR of their own{/red-fg}");
  assert.equal(prActionRefusal(row({ status: "tracker ticket", pr: 8 })), "{red-fg}parent tickets have no PR of their own{/red-fg}");
  assert.equal(prActionRefusal(row({ status: "ready to merge", section: "merge", pr: 9 })), undefined);
});

test("rowForAction gives a notice for a card yimbot has no session for", () => {
  assert.deepEqual(rowForAction(card({ row: null })), { notice: "{red-fg}no yimbot session for this ticket{/red-fg}" });
});

test("rowForAction says no ticket is selected when the column is empty", () => {
  assert.deepEqual(rowForAction(undefined), { notice: "{red-fg}no ticket selected{/red-fg}" });
});

test("resolveFocus keeps a focus id that is still on the board", () => {
  assert.equal(resolveFocus(["a", "b", "parents"], "b"), "b");
  assert.equal(resolveFocus(["a", "parents"], "parents"), "parents");
});

test("resolveFocus falls back to the first column when the focused one disappears", () => {
  assert.equal(resolveFocus(["a", "b"], "gone"), "a");
  assert.equal(resolveFocus(["a", "b"], "parents"), "a");
});

test("resolveFocus keeps the id while the board has nothing to focus", () => {
  assert.equal(resolveFocus([], "a"), "a");
});

test("resolveFocus leaves an unset focus alone until the first column arrives", () => {
  assert.equal(resolveFocus(["parents"], ""), "");
  assert.equal(resolveFocus(["a", "b", "parents"], ""), "a");
});

test("resolveFocus still hands a vanished column's focus to the parents pane", () => {
  assert.equal(resolveFocus(["parents"], "gone"), "parents");
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

test("latestOnly drops a slow older result that lands after a newer one", async () => {
  const pending = [deferred<number>(), deferred<number>()];
  let call = 0;
  const applied: number[] = [];
  const refresh = latestOnly(() => pending[call++].promise, (v) => applied.push(v));
  refresh();
  refresh();
  pending[1].resolve(2);
  await pending[1].promise;
  pending[0].resolve(1);
  await pending[0].promise;
  await Promise.resolve();
  assert.deepEqual(applied, [2]);
});

test("latestOnly applies results that land in order and ignores rejections", async () => {
  const applied: number[] = [];
  let n = 0;
  const refresh = latestOnly(async () => {
    n++;
    if (n === 2) throw new Error("down");
    return n;
  }, (v) => applied.push(v));
  refresh();
  await new Promise((r) => setImmediate(r));
  refresh();
  await new Promise((r) => setImmediate(r));
  refresh();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(applied, [1, 3]);
});

test("placeColumns lays every column side by side when they fit, the last taking the leftover cells", () => {
  const { start, slots } = placeColumns(["a", "b", "c"], "a", 0, 10, 100);
  assert.equal(start, 0);
  assert.deepEqual(slots, [
    { id: "a", left: 10, width: 33 },
    { id: "b", left: 43, width: 33 },
    { id: "c", left: 76, width: 34 },
  ]);
});

test("placeColumns scrolls to keep the focused column in view", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const { start, slots } = placeColumns(ids, "e", 0, 0, 50);
  assert.equal(start, 3);
  assert.deepEqual(slots.map((s) => s.id), ["d", "e"]);
  assert.deepEqual(slots.map((s) => s.width), [25, 25]);
});

test("placeColumns keeps the previous window while the parents pane holds the focus", () => {
  const ids = ["a", "b", "c", "d", "e"];
  assert.deepEqual(placeColumns(ids, "parents", 2, 0, 50).slots.map((s) => s.id), ["c", "d"]);
  assert.deepEqual(placeColumns(ids, "parents", 9, 0, 50).slots.map((s) => s.id), ["d", "e"]);
});

test("placeColumns places nothing on an empty board", () => {
  assert.deepEqual(placeColumns([], "", 0, 0, 80), { start: 0, slots: [] });
});

test("styleParentsPane outlines and inverses the parents pane only while it holds the focus", () => {
  const pane = { style: { border: { fg: "" }, label: { fg: "" }, selected: { inverse: true } } };
  styleParentsPane(pane, true);
  assert.deepEqual(pane.style, { border: { fg: FOCUS_BORDER }, label: { fg: FOCUS_BORDER }, selected: { inverse: true } });
  styleParentsPane(pane, false);
  assert.deepEqual(pane.style, { border: { fg: "grey" }, label: { fg: "grey" }, selected: { inverse: false } });
});

test("bindQuitKeys binds only C-c: q and escape must not quit the board", () => {
  const handlers: Record<string, () => void> = {};
  const fakeScreen = {
    key: (keys: string[], fn: () => void) => {
      for (const k of keys) handlers[k] = fn;
    },
  };
  let quitCalls = 0;
  bindQuitKeys(fakeScreen, () => false, () => quitCalls++);

  assert.deepEqual(Object.keys(handlers), ["C-c"], "C-c is the only quit key");
  handlers["C-c"]();
  assert.equal(quitCalls, 1, "C-c quits");
});

test("bindQuitKeys stands down on C-c while the claude pane is focused so the pty gets it", () => {
  const handlers: Record<string, () => void> = {};
  const fakeScreen = {
    key: (keys: string[], fn: () => void) => {
      for (const k of keys) handlers[k] = fn;
    },
  };
  let claudeFocused = true;
  let quitCalls = 0;
  bindQuitKeys(fakeScreen, () => claudeFocused, () => quitCalls++);

  handlers["C-c"]();
  assert.equal(quitCalls, 0, "C-c must not quit while the claude pane is focused");

  claudeFocused = false;
  handlers["C-c"]();
  assert.equal(quitCalls, 1, "C-c hard-quits again once claude is not focused");
});

test("bindSettingsKey does not reopen the panel on a second s while it is already open", () => {
  const handlers: Record<string, () => void> = {};
  const fakeScreen = {
    key: (keys: string[], fn: () => void) => {
      for (const k of keys) handlers[k] = fn;
    },
  };
  let settingsOpen = false;
  let openCalls = 0;
  bindSettingsKey(fakeScreen, () => settingsOpen, () => {
    settingsOpen = true;
    openCalls++;
  });

  handlers["s"]();
  assert.equal(openCalls, 1, "the first s opens the panel");

  handlers["s"]();
  assert.equal(openCalls, 1, "a second s while the panel is open must not open another one");

  settingsOpen = false;
  handlers["s"]();
  assert.equal(openCalls, 2, "s opens again once the panel is closed");
});

test("footerHint advertises the manual ready-label key on the review pane", () => {
  assert.match(footerHint(), /r ready/);
});

test("bindReadyKey gates r while settings is open", () => {
  const handlers: Record<string, () => void> = {};
  const fakeScreen = {
    key: (keys: string[], fn: () => void) => {
      for (const k of keys) handlers[k] = fn;
    },
  };
  let settingsOpen = true;
  let addCalls = 0;
  bindReadyKey(fakeScreen, () => settingsOpen, () => addCalls++);

  handlers["r"]();
  assert.equal(addCalls, 0, "r must not label the hidden board's row while the panel is open");

  settingsOpen = false;
  handlers["r"]();
  assert.equal(addCalls, 1, "r labels again once the panel is closed");
});

test("bindFlagKey gates f while settings is open", () => {
  const handlers: Record<string, () => void> = {};
  const fakeScreen = {
    key: (keys: string[], fn: () => void) => {
      for (const k of keys) handlers[k] = fn;
    },
  };
  let settingsOpen = true;
  let toggleCalls = 0;
  bindFlagKey(fakeScreen, () => settingsOpen, () => toggleCalls++);

  handlers["f"]();
  assert.equal(toggleCalls, 0, "f must not flag the hidden board's row while the panel is open");

  settingsOpen = false;
  handlers["f"]();
  assert.equal(toggleCalls, 1, "f flags again once the panel is closed");
});

test("statusContent shows an unexpired notice and drops it after its ttl", () => {
  const notice = { text: "adding ready label to #481…", until: 10_000 };
  assert.match(statusContent("supervised", notice, 9_999, []), /adding ready label to #481/);
  assert.doesNotMatch(statusContent("supervised", notice, 10_000, []), /adding ready label/);
  assert.doesNotMatch(statusContent("supervised", null, 0, []), /adding ready label/);
});

test("handleReadyPress reports the same outcome the review overlay does", async () => {
  const notices: string[] = [];
  await handleReadyPress(
    row({ pr: 481 }),
    () => Promise.resolve(),
    (text) => notices.push(text),
  );
  assert.equal(notices.length, 2);
  assert.match(notices[0], /#481/);
  assert.match(notices[1], /#481 ready to merge/);
});

test("handleReadyPress hands the row's repo to the label writer", async () => {
  const seen: (string | undefined)[] = [];
  await handleReadyPress(
    row({ pr: 12, repo: "acme/tf" }),
    (_pr, _key, _label, repo) => {
      seen.push(repo);
      return Promise.resolve();
    },
    () => {},
  );
  await handleReadyPress(row({ pr: 13 }), (_pr, _key, _label, repo) => {
    seen.push(repo);
    return Promise.resolve();
  }, () => {});
  assert.deepEqual(seen, ["acme/tf", undefined]);
});

test("handleReadyPress surfaces the failure instead of losing it to console", async () => {
  const notices: string[] = [];
  await handleReadyPress(
    row({ pr: 481 }),
    () => Promise.reject(new Error("gh exited 1")),
    (text) => notices.push(text),
  );
  assert.equal(notices.length, 2);
  assert.match(notices[1], /failed/);
  assert.match(notices[1], /gh exited 1/);
});

test("handleReadyPress tells the operator when the row has no PR to label", async () => {
  const notices: string[] = [];
  let added = false;
  await handleReadyPress(
    row({}),
    () => {
      added = true;
      return Promise.resolve();
    },
    (text) => notices.push(text),
  );
  assert.equal(added, false, "no PR means no label write");
  assert.equal(notices.length, 1);
  assert.match(notices[0], /no PR/);
});

test("handleReadyPress does nothing with no row selected", async () => {
  const notices: string[] = [];
  await handleReadyPress(undefined, () => Promise.resolve(), (text) => notices.push(text));
  assert.deepEqual(notices, []);
});

// A minimal EventEmitter standing in for a TTY stream, sized to the columns
// and rows a real terminal would report. blessed only reads .columns/.rows
// and a handful of stream methods off input/output; it never touches a real
// fd, so this is enough to render the widget tree headlessly and inspect
// screen.lines for what would actually be on screen.
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

// Builds the same table (bottom: 1) + footer layout runTui uses, against a
// fake terminal of the given size, and returns the rendered text per row so a
// test can check what actually landed where. The footer comes from the real
// footerLayout() (production's own object, not a copy), so a regression in
// that layout fails this test. Enough data rows are given to fill the table
// area regardless of terminal height.
function renderBoardLines(columns: number, rows: number): string[] {
  const { input, output } = fakeTty(columns, rows);
  const screen = blessed.screen({ input, output, terminal: "xterm", smartCSR: true, fullUnicode: true });
  const table = blessed.listtable({
    parent: screen,
    top: 1,
    left: 0,
    right: 0,
    bottom: 1,
    tags: true,
    align: "left",
    keys: true,
    vi: true,
    mouse: true,
    style: { header: { bold: true }, cell: { selected: { inverse: true } } },
  });
  const data = [["TIME", "DUR", "STATUS", "TICKET", "PR", "TITLE", "FLAG"]];
  for (let i = 0; i < rows; i++) data.push([`09:${i}`, "1m", "working", `ENG-${i}`, "", `row ${i}`, ""]);
  table.setData(data);
  blessed.text({ parent: screen, ...footerLayout() });
  screen.render();
  const lines = screen.lines.map((line: [number, string][]) =>
    line.map((cell) => cell[1]).join("").replace(/\s+$/, ""),
  );
  screen.destroy();
  return lines;
}

// Renders just the header row plus the bordered tasks pane beneath it, using
// production's own titleLayout/statusLayout objects, so an inset regression
// fails this test.
function renderHeaderLines(columns: number, rows: number, board: { cycleNumber: number | null } | null = null): string[] {
  const { input, output } = fakeTty(columns, rows);
  const screen = blessed.screen({ input, output, terminal: "xterm", smartCSR: true, fullUnicode: true });
  blessed.listtable({
    parent: screen,
    top: 1,
    left: 0,
    right: 0,
    bottom: 1,
    tags: true,
    border: { type: "line" },
    noCellBorders: true,
    data: [["TICKET"], ["ENG-1"]],
  });
  blessed.text({ parent: screen, ...titleLayout(), content: titleContent(board) });
  blessed.text({
    parent: screen,
    ...statusLayout(),
    content: statusContent("supervised", null, Date.now(), []),
  });
  screen.render();
  const lines = screen.lines.map((line: [number, string][]) =>
    line.map((cell) => cell[1]).join("").replace(/\s+$/, ""),
  );
  screen.destroy();
  return lines;
}

test("footer at height 1 clips instead of wrapping, so it never covers the table's last row", () => {
  const columns = 80;
  const rows = 24;
  const lines = renderBoardLines(columns, rows);
  // table is `bottom: 1`, so its content fills up to one row above the
  // screen's last row; that row must still show a ticket, not footer text.
  const lastTableRow = lines[rows - 2];
  assert.match(lastTableRow, /ENG-\d+/, "the table's last row must survive, not be painted over");
  assert.doesNotMatch(lastTableRow, /returns here/);
  // the footer itself is confined to the final row, clipped rather than
  // spilling onto a second line.
  assert.equal(lines.length, rows);
});

test("footer clips at a narrow width, still sparing the table's last row", () => {
  const columns = 60;
  const rows = 20;
  const lines = renderBoardLines(columns, rows);
  const lastTableRow = lines[rows - 2];
  assert.match(lastTableRow, /ENG-\d+/, "the table's last row must survive, not be painted over");
  assert.equal(lines.length, rows);
});

test("titleLayout and statusLayout inset the header inside the pane's border", () => {
  assert.equal(titleLayout().left, headerInset);
  assert.equal(statusLayout().right, headerInset);
  assert.ok(headerInset >= 2, "must clear the pane border (col 0) plus a margin");
});

test("the header row sits inside the pane below it, not over its border columns", () => {
  const columns = 80;
  const lines = renderHeaderLines(columns, 24);
  const header = lines[0];
  const paneTop = lines[1];
  // the pane's border owns column 0 and the last column; the header must start
  // inside them with a margin, and end before the right border's margin.
  assert.equal(header.indexOf("yimbot"), headerInset);
  assert.ok(paneTop.length >= columns - 1, "the pane border should span the width");
  const padded = header.padEnd(columns, " ");
  assert.equal(padded.slice(columns - headerInset), " ".repeat(headerInset), "right margin must be blank");
  assert.match(header, /SUPERVISED/);
});

test("the header shows the cycle number right after the wordmark", () => {
  const header = renderHeaderLines(80, 24, { cycleNumber: 42 })[0];
  assert.equal(header.indexOf("yimbot cycle 42"), headerInset);
  assert.match(header, /SUPERVISED/);
});

test("footerHint names the review key", () => {
  assert.ok(footerHint().includes("R review"));
});

test("bindReviewKey opens only when no overlay is open", () => {
  const handlers: Record<string, () => void> = {};
  const screen = { key: (keys: string[], fn: () => void) => { for (const k of keys) handlers[k] = fn; } };
  let opened = 0;
  let overlay = false;
  bindReviewKey(screen, () => overlay, () => { opened++; });
  handlers["S-r"]();
  assert.equal(opened, 1);
  overlay = true;
  handlers["S-r"]();
  assert.equal(opened, 1);
});

test("parentRows renders one compact line per parent: the ticket, then its title in grey", () => {
  const a = row({ key: "ENG-1", label: "ENG-1", status: "tracker ticket", title: "Split the thing" });
  const b = row({ key: "ENG-2", label: "ENG-2", status: "waiting on slices" });
  const rows = parentRows([a, b]);
  assert.deepEqual(rows[0], ["PARENTS"]);
  assert.equal(rows[1][0], "ENG-1 {grey-fg}Split the thing{/grey-fg}");
  assert.equal(rows[2][0], "ENG-2");
});

test("parentRows clips a long title to the box's interior", () => {
  const a = row({ key: "ENG-1", label: "ENG-1", status: "tracker ticket", title: "x".repeat(60) });
  const cell = parentRows([a])[1][0];
  assert.ok(cellWidth(cell) <= QUEUE_PANE_WIDTH - 2, `cell is ${cellWidth(cell)} wide`);
  assert.ok(cell.includes("…"));
});

test("boardLayout gives the columns the body between the title and the footer, past the queue", () => {
  const l = boardLayout(24, 200);
  assert.deepEqual(l.board, { top: 1, left: QUEUE_PANE_WIDTH, right: 0, bottom: 1 });
});

test("boardLayout keeps the parents box out of the way while it has no rows", () => {
  const l = boardLayout(24, 200, 0);
  assert.equal(l.parents, null);
  assert.equal(l.queue!.bottom, 1);
  assert.equal(l.board.left, QUEUE_PANE_WIDTH);
  assert.deepEqual(boardLayout(24, 200), l);
});

test("boardLayout stacks the parents box under the queue, at the queue's width", () => {
  const l = boardLayout(30, 200, 2);
  // 2 rows + header + 2 border rows.
  assert.deepEqual(l.parents, { left: 0, width: QUEUE_PANE_WIDTH, bottom: 1, height: 5 });
  assert.equal(l.queue!.bottom, 6);
  assert.deepEqual(l.board, { top: 1, left: QUEUE_PANE_WIDTH, right: 0, bottom: 1 });
});

test("boardLayout caps the parents box at half the body so the queue keeps the rest", () => {
  const l = boardLayout(42, 200, 30);
  // Body is 40 rows, half is 20.
  assert.equal(l.parents!.height, 20);
  assert.equal(l.queue!.bottom, 21);
});

test("boardLayout drops the parents box before it squeezes the queue out", () => {
  // Body is 7: the queue needs 4, leaving 3, short of the 4 a one-row box needs.
  assert.equal(boardLayout(9, 200, 1).parents, null);
  assert.equal(boardLayout(9, 200, 1).queue!.bottom, 1);
  // Body is 8: exactly room for both at their floors.
  assert.equal(boardLayout(10, 200, 1).parents!.height, 4);
});

test("boardLayout drops the parents box with the queue on a narrow screen", () => {
  const l = boardLayout(40, 50, 3);
  assert.equal(l.queue, null);
  assert.equal(l.parents, null);
});

test("boardLayout reserves the left edge for the queue pane", () => {
  const layout = boardLayout(40, 200);
  assert.ok(layout.queue, "a wide screen gets a queue pane");
  assert.equal(layout.queue!.width, QUEUE_PANE_WIDTH);
  assert.equal(layout.queue!.left, 0);
  assert.equal(layout.board.left, QUEUE_PANE_WIDTH);
});

test("boardLayout drops the queue pane rather than let it crowd the board", () => {
  assert.equal(boardLayout(40, 72).queue, null);
  assert.ok(boardLayout(40, 80).queue, "80 columns leaves room for the board beside the pane");
});

test("boardLayout drops the queue pane on a narrow screen", () => {
  const layout = boardLayout(40, 50);
  assert.equal(layout.queue, null);
  assert.equal(layout.board.left, 0);
});

test("boardLayout keeps the queue pane spanning the full board height", () => {
  const layout = boardLayout(40, 200);
  assert.equal(layout.queue!.top, layout.board.top);
  assert.equal(layout.queue!.bottom, 1);
});

test("bindPaneNavKeys maps ctrl-jk (and the linefeed alias) to moves, gated by overlays", () => {
  const handlers: Record<string, () => void> = {};
  const screen = { key: (keys: string[], fn: () => void) => { for (const k of keys) handlers[k] = fn; } };
  const moves: string[] = [];
  let overlay = false;
  bindPaneNavKeys(screen, () => overlay, (dir) => moves.push(dir));
  handlers["C-j"]();
  handlers["C-k"]();
  assert.deepEqual(moves, ["down", "up"]);
  // Ctrl+J arrives as linefeed in most terminals.
  handlers["linefeed"]();
  assert.deepEqual(moves.slice(2), ["down"]);
  overlay = true;
  handlers["C-j"]();
  assert.equal(moves.length, 3);
});

function fakeScreen() {
  const handlers: Record<string, () => void> = {};
  return { handlers, screen: { key: (keys: string[], fn: () => void) => { for (const k of keys) handlers[k] = fn; } } };
}

test("bindColumnKeys moves left on h and right on l while active", () => {
  const { handlers, screen } = fakeScreen();
  const moves: string[] = [];
  bindColumnKeys(screen, () => false, () => true, (dir) => moves.push(dir));
  handlers["h"]();
  handlers["l"]();
  assert.deepEqual(moves, ["left", "right"]);
});

test("bindColumnKeys does nothing while inactive or while an overlay is open", () => {
  const { handlers, screen } = fakeScreen();
  const moves: string[] = [];
  let overlay = false;
  let active = false;
  bindColumnKeys(screen, () => overlay, () => active, (dir) => moves.push(dir));
  handlers["h"]();
  handlers["l"]();
  active = true;
  overlay = true;
  handlers["h"]();
  handlers["l"]();
  assert.deepEqual(moves, []);
});

test("stepping past either end keeps the focus and an empty board is a no-op", () => {
  const order = ["a", "b", "parents"];
  assert.equal(stepFocus(order, "parents", "next"), "parents");
  assert.equal(stepFocus(order, "a", "prev"), "a");
  assert.equal(stepFocus([], "", "next"), "");
  assert.equal(stepFocus([], "", "prev"), "");
});

test("makeSelectGuard consumes an armed flag once", () => {
  const guard = makeSelectGuard();
  assert.equal(guard.consume(), false);
  guard.arm();
  assert.equal(guard.consume(), true);
  assert.equal(guard.consume(), false);
});

test("makeSelectGuard clears itself on the next tick", async () => {
  const guard = makeSelectGuard();
  guard.arm();
  await new Promise((r) => setImmediate(r));
  assert.equal(guard.consume(), false);
});

test("the pane-switch keys moved to the help overlay", () => {
  assert.ok(helpLines("Y").join("\n").includes("^j/^k"));
});

test("footerHint fits a 130-column terminal so the tail hints survive wrap:false", () => {
  assert.ok(footerHint().length <= 130, `footer is ${footerHint().length} chars`);
});

test("bindPaneToggle gates tab while an overlay is open", () => {
  const handlers: Record<string, () => void> = {};
  const screen = { key: (keys: string[], fn: () => void) => { for (const k of keys) handlers[k] = fn; } };
  let toggles = 0;
  let overlay = false;
  bindPaneToggle(screen, () => overlay, () => { toggles++; });
  handlers["tab"]();
  assert.equal(toggles, 1);
  overlay = true;
  handlers["tab"]();
  assert.equal(toggles, 1);
});

test("onPaneFocusChange repaints once the mouse moves focus to another pane", () => {
  let pane = "tasks";
  const deferred: Array<() => void> = [];
  let renders = 0;
  const onFocus = onPaneFocusChange(
    () => pane,
    (p) => { pane = p; },
    () => { renders++; },
    (fn) => { deferred.push(fn); },
  );
  // Keyboard path: focusedPane is already set before focus() fires the sync.
  onFocus("tasks");
  assert.equal(deferred.length, 0);
  // Mouse path: blessed focused the review list on its own.
  onFocus("review");
  assert.equal(pane, "review");
  assert.equal(renders, 0);
  deferred.shift()!();
  assert.equal(renders, 1);
  // A focus rewind that hidePanesKeepingFocus puts back before the tick: no repaint.
  onFocus("merge");
  pane = "review";
  deferred.shift()!();
  assert.equal(renders, 1);
});

test("hidePanesKeepingFocus survives blessed rewinding focus onto a sibling pane", () => {
  const { input, output } = fakeTty(80, 24);
  const screen = blessed.screen({ input, output, terminal: "xterm", smartCSR: true });
  const tasks = blessed.listtable({ parent: screen, top: 5, height: 5, keys: true, mouse: true });
  const review = blessed.listtable({ parent: screen, top: 0, height: 5, keys: true, mouse: true });
  const merge = blessed.listtable({ parent: screen, top: 10, height: 5, keys: true, mouse: true });
  const parents = blessed.listtable({ parent: screen, top: 15, height: 5, keys: true, mouse: true });
  const widgets = { tasks, review, merge, parents };
  let pane = "tasks";
  for (const [id, w] of Object.entries(widgets)) w.on("focus", () => { pane = id; });
  // Operator visited merge, then came back to tasks: blessed's focus history
  // now holds merge behind tasks, so hiding tasks rewinds focus onto merge.
  merge.focus();
  tasks.focus();
  hidePanesKeepingFocus(Object.values(widgets), () => pane, (p) => { pane = p; });
  assert.equal(pane, "tasks");
  assert.equal(tasks.hidden, true);
  assert.equal(review.hidden, true);
  assert.equal(merge.hidden, true);
  screen.destroy();
});

test("screenTerm borrows xterm-256color only for 256-color multiplexer terms", () => {
  assert.equal(screenTerm("tmux-256color"), "xterm-256color");
  assert.equal(screenTerm("screen-256color"), "xterm-256color");
  assert.equal(screenTerm("tmux"), undefined);
  assert.equal(screenTerm("screen"), undefined);
  assert.equal(screenTerm("xterm-256color"), undefined);
  assert.equal(screenTerm("alacritty"), undefined);
  assert.equal(screenTerm(undefined), undefined);
});

test("cellWidth measures visible width, ignoring blessed tags", () => {
  assert.equal(cellWidth("merged"), 6);
  assert.equal(cellWidth("{grey-fg}merged{/grey-fg}"), 6);
  assert.equal(cellWidth("{red-fg}⚑{/red-fg}"), 1);
});

test("cellWidth measures display width the way blessed does", () => {
  // The screen runs fullUnicode, so blessed sizes columns by display width:
  // a CJK title is two columns per character and a combining mark is zero.
  assert.equal(cellWidth("需要审核"), 8);
  assert.equal(cellWidth("café"), 4);
});

test("cellWidth strips the same tags blessed does", () => {
  assert.equal(cellWidth("{red-fg}⚑{/red-fg}"), 1);
  // Not a blessed tag: braces around arbitrary text are literal content.
  assert.equal(cellWidth("{a b}"), 5);
});

test("reachWarnings is empty while everything answers", () => {
  assert.equal(reachWarnings([]), "");
});

test("reachWarnings names each failing service in red", () => {
  assert.equal(reachWarnings(["github"]), "{red-fg}⚠ github{/red-fg} ");
  assert.equal(
    reachWarnings(["github", "linear"]),
    "{red-fg}⚠ github{/red-fg} {red-fg}⚠ linear{/red-fg} ",
  );
});

test("statusContent leads with the reach warnings, ahead of the mode chip", () => {
  const bar = statusContent("supervised", null, 0, ["github"]);
  assert.ok(bar.startsWith("{red-fg}⚠ github{/red-fg}"));
  assert.ok(bar.indexOf("github") < bar.indexOf("SUPERVISED"));
});

test("statusContent says nothing about reachability while every service answers", () => {
  assert.doesNotMatch(statusContent("supervised", null, 0, []), /⚠/);
});


test("footerHint names the view key", () => {
  assert.equal(footerHint(), "r ready   R review   v view   ? help   ^c quit");
});

test("helpLines lists v and h/l", () => {
  const text = helpLines("Y").join("\n");
  assert.match(text, /\{bold\}v\s*\{\/bold\}  toggle kanban view/);
  assert.match(text, /\{bold\}h\/l\s*\{\/bold\}  move between columns \(kanban\)/);
});

test("nextView toggles", () => {
  assert.equal(nextView("table"), "kanban");
  assert.equal(nextView("kanban"), "table");
});

test("the default view is table", () => {
  assert.equal(DEFAULT_VIEW, "table");
});

test("bindViewKey fires on v and not while an overlay is open", () => {
  const handlers: Record<string, () => void> = {};
  const screen = { key: (keys: string[], fn: () => void) => { for (const k of keys) handlers[k] = fn; } };
  let overlay = true;
  let toggles = 0;
  bindViewKey(screen, () => overlay, () => toggles++);
  handlers["v"]();
  assert.equal(toggles, 0, "v must not switch views while an overlay is open");
  overlay = false;
  handlers["v"]();
  assert.equal(toggles, 1);
});

const column = (id: string): Column => ({ id, title: id, color: "white", cards: [] });

test("viewFocusOrder lists the non-empty table panes in table view and the column ids in kanban view, parents last when present", () => {
  const counts = { tasks: 2, review: 0, merge: 1 };
  const columns = [column("a"), column("b")];
  assert.deepEqual(viewFocusOrder("table", counts, columns, false), ["tasks", "merge"]);
  assert.deepEqual(viewFocusOrder("table", counts, columns, true), ["tasks", "merge", "parents"]);
  assert.deepEqual(viewFocusOrder("kanban", counts, columns, false), ["a", "b"]);
  assert.deepEqual(viewFocusOrder("kanban", counts, columns, true), ["a", "b", "parents"]);
});

test("a stale id resolves to the first stop of the new view", () => {
  assert.equal(viewFocus("kanban", ["a", "b", "parents"], "review"), "a");
  assert.equal(viewFocus("table", ["tasks", "merge", "parents"], "a"), "tasks");
  assert.equal(viewFocus("table", ["review", "parents"], "a"), "review");
  assert.equal(viewFocus("table", ["merge"], "tasks"), "merge");
});

test("a focus id still in the view's order stays put, parents included", () => {
  assert.equal(viewFocus("table", ["tasks", "parents"], "parents"), "parents");
  assert.equal(viewFocus("kanban", ["a", "parents"], "parents"), "parents");
  assert.equal(viewFocus("kanban", ["a", "b"], "b"), "b");
});

test("an empty table falls back to the tasks pane, never a stale column id", () => {
  assert.equal(viewFocus("table", [], "a"), "tasks");
  assert.equal(viewFocus("table", [], "merge"), "merge");
});

test("headerBoard hides the cycle in table view and passes the board in kanban view", () => {
  const board = { cycleNumber: 7 } as Parameters<typeof headerBoard>[1];
  assert.equal(headerBoard("table", board), null);
  assert.equal(headerBoard("kanban", board), board);
  assert.equal(headerBoard("kanban", null), null);
});

test("tableSections keeps parents in their own box when it has room", () => {
  const t = row({ key: "T" });
  const p = row({ key: "P", status: "waiting on slices" });
  const r = row({ key: "R", section: "review" });
  const m = row({ key: "M", section: "merge" });
  const s = tableSections([t, p, r, m], true);
  assert.deepEqual(s.tasks.map((x) => x.key), ["T"]);
  assert.deepEqual(s.parents.map((x) => x.key), ["P"]);
  assert.deepEqual(s.review.map((x) => x.key), ["R"]);
  assert.deepEqual(s.merge.map((x) => x.key), ["M"]);
});

test("tableSections puts parents back in tasks when the rail has no room", () => {
  const t = row({ key: "T" });
  const p = row({ key: "P", status: "waiting on slices" });
  const s = tableSections([p, t], false);
  assert.deepEqual(s.tasks.map((x) => x.key), ["T", "P"]);
  assert.deepEqual(s.parents, []);
});

test("onlyInView runs the callback only while that view shows", () => {
  let view: "table" | "kanban" = "table";
  let calls = 0;
  const tick = onlyInView("kanban", () => view, () => calls++);
  tick();
  assert.equal(calls, 0, "no Linear board fetch in table view");
  view = "kanban";
  tick();
  assert.equal(calls, 1);
});

test("switching into kanban before the board loads waits for the first column instead of the parents pane", () => {
  assert.equal(viewFocus("kanban", ["parents"], "tasks", false), "");
  assert.equal(viewFocus("kanban", ["a", "b", "parents"], "", true), "a");
});

test("a loaded kanban board still hands a stale table id to its first stop", () => {
  assert.equal(viewFocus("kanban", ["a", "parents"], "tasks", true), "a");
  assert.equal(viewFocus("kanban", ["parents"], "parents", false), "parents");
});

test("switching back to the table from parents or a column lands on the first table stop", () => {
  assert.equal(viewFocus("table", ["tasks", "review"], "parents"), "tasks");
  assert.equal(viewFocus("table", ["tasks", "review"], "col-1"), "tasks");
  assert.equal(viewFocus("table", ["tasks", "parents"], ""), "tasks");
  assert.equal(viewFocus("table", ["parents"], ""), "tasks");
});

test("isTableId accepts exactly the table pane ids", () => {
  for (const id of TABLE_IDS) assert.equal(isTableId(id), true);
  assert.equal(isTableId("parents"), false);
  assert.equal(isTableId("col-1"), false);
});
