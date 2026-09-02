import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import blessed from "neo-blessed";
import { alignTables, applyOrder, bindFlagKey, bindModeKey, bindPaneFocusSync, bindHelpKey, bindPaneNavKeys, bindPaneToggle, bindQuitKeys, bindReadyKey, bindReviewKey, bindSettingsKey, boardLayout, boardTable, BOARD_HEADER, cellWidth, fmtDuration, footerHint, footerLayout, handleReadyPress, headerInset, statusLayout, titleLayout, helpLines, modeContent, movePane, nextPane, paneBorderColor, partitionRows, resolvePane, returnKey, screenTerm, selectedBoardRow, statusContent, type PaneCounts } from "./tui.ts";
import type { BoardRow } from "./events.ts";

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

test("every pane shares one header, in one order", () => {
  assert.deepEqual(BOARD_HEADER, [
    "TIME", "DUR", "STATUS", "TICKET", "PR", "TITLE", "FLAG", "REASON", "WHY",
  ]);
  assert.deepEqual(boardTable([])[0], BOARD_HEADER);
});

test("boardTable renders #N in the PR column and the title", () => {
  const [, body] = boardTable([{ row: row({ pr: 481, title: "add column" }) }], 0);
  assert.equal(body[4], "#481");
  assert.equal(body[5], "add column");
});

test("boardTable leaves the PR cell blank when pr is absent", () => {
  const [, body] = boardTable([{ row: row({}) }], 0);
  assert.equal(body[4], "");
});

test("boardTable DUR uses now - startTs for an active row", () => {
  const [, body] = boardTable([{ row: row({ startTs: 0, ts: 0 }) }], 65_000);
  assert.equal(body[1], "1m");
});

test("boardTable DUR is frozen at ts - startTs for a terminal row", () => {
  const [, body] = boardTable([{ row: row({ terminal: true, startTs: 0, ts: 60_000 }) }], 999_999);
  assert.equal(body[1], "1m");
});

test("boardTable marks a flagged row and leaves others blank", () => {
  const [, flagged] = boardTable([{ row: row({ flagged: true, flagReasons: ["manual"] }) }], 0);
  assert.equal(flagged[6], "{red-fg}⚑{/red-fg}");
  const [, plain] = boardTable([{ row: row({}) }], 0);
  assert.equal(plain[6], "");
});

test("boardTable joins the flag reasons in the REASON cell", () => {
  const [, body] = boardTable(
    [{ row: row({ flagged: true, flagReasons: ["input", "changes-requested"] }) }],
    0,
  );
  assert.equal(body[7], "{red-fg}input,changes-requested{/red-fg}");
});

test("boardTable leaves the REASON cell blank when unflagged", () => {
  const [, body] = boardTable([{ row: row({}) }], 0);
  assert.equal(body[7], "");
});

test("boardTable dims a terminal row's status", () => {
  const [, body] = boardTable([{ row: row({ status: "merged", terminal: true }) }], 0);
  assert.equal(body[2], "{grey-fg}merged{/grey-fg}");
});

test("boardTable puts the review pane's ordering rationale in WHY, blank elsewhere", () => {
  const [, why] = boardTable([{ row: row({ pr: 11 }), why: "base of the stack" }], 0);
  assert.equal(why[8], "base of the stack");
  const [, plain] = boardTable([{ row: row({}) }], 0);
  assert.equal(plain[8], "");
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
  for (const pane of ["tasks", "review", "merge"] as const) {
    const hint = footerHint(pane);
    assert.match(hint, /\? help/);
    assert.match(hint, /q quit/);
    assert.doesNotMatch(hint, /j\/k move|f flag|m mode|s settings|returns here|tab pane/);
  }
});

test("footerHint shows r/R on every pane: r reaches an unlabeled row wherever it sits", () => {
  assert.match(footerHint("review"), /r ready {3}R review/);
  assert.match(footerHint("merge"), /r ready {3}R review/);
  assert.match(footerHint("tasks"), /r ready {3}R review/);
});

test("helpLines carries every keybind the footer no longer shows", () => {
  const text = helpLines("F12").join("\n");
  for (const needle of [
    "j/k", "^j/^k", "tab", "enter", "f", "r", "R", "m", "s", "?", "q", "prefix+F12",
  ]) {
    assert.ok(text.includes(needle), `help must mention ${needle}`);
  }
  assert.doesNotMatch(text, /review pane/);
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
  assert.doesNotMatch(footerHint("tasks"), /s settings/);
  assert.match(helpLines("Y").join("\n"), /settings/);
});

test("footerHint no longer advertises a refine key (refine lives in settings)", () => {
  assert.doesNotMatch(footerHint("review"), /refine/);
});

test("statusContent shows a red refine-off chip while refine is off", () => {
  const off = statusContent("supervised", false, 2, null, 0);
  assert.match(off, /REFINE OFF/);
  assert.match(off, /red-bg/);
});

test("statusContent shows a green refine-on chip while refine is on", () => {
  const on = statusContent("supervised", true, 2, null, 0);
  assert.match(on, /REFINE ON/);
  assert.match(on, /green-bg.*REFINE ON/);
});

test("bindQuitKeys gates q and escape while settings is open, but C-c always fires", () => {
  const handlers: Record<string, () => void> = {};
  const fakeScreen = {
    key: (keys: string[], fn: () => void) => {
      for (const k of keys) handlers[k] = fn;
    },
  };
  let settingsOpen = true;
  let quitCalls = 0;
  bindQuitKeys(fakeScreen, () => settingsOpen, () => false, () => quitCalls++);

  handlers["q"]();
  handlers["escape"]();
  assert.equal(quitCalls, 0, "q and escape must not quit while the panel is open");

  handlers["C-c"]();
  assert.equal(quitCalls, 1, "C-c must quit even while the panel is open");

  settingsOpen = false;
  handlers["q"]();
  assert.equal(quitCalls, 2, "q quits again once the panel is closed");
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
  bindQuitKeys(fakeScreen, () => true, () => claudeFocused, () => quitCalls++);

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
  assert.match(footerHint("review"), /r ready/);
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
  assert.match(statusContent("supervised", true, 2, notice, 9_999), /adding ready label to #481/);
  assert.match(statusContent("supervised", true, 2, notice, 9_999), /2 active/);
  assert.doesNotMatch(statusContent("supervised", true, 2, notice, 10_000), /adding ready label/);
  assert.doesNotMatch(statusContent("supervised", true, 2, null, 0), /adding ready label/);
});

test("handleReadyPress shows a pending notice, then success once the label lands", async () => {
  const notices: string[] = [];
  await handleReadyPress(
    row({ pr: 481 }),
    () => Promise.resolve(),
    (text) => notices.push(text),
  );
  assert.equal(notices.length, 2);
  assert.match(notices[0], /#481/);
  assert.match(notices[1], /#481 marked ready/);
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
function renderHeaderLines(columns: number, rows: number): string[] {
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
  blessed.text({ parent: screen, ...titleLayout(), content: "yimbot" });
  blessed.text({
    parent: screen,
    ...statusLayout(),
    content: statusContent("supervised", true, 3, null, Date.now()),
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
  assert.match(header, /active/);
});

test("footerHint names the review key", () => {
  assert.ok(footerHint("review").includes("R review"));
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

test("partitionRows splits on the row's section, preserving order", () => {
  const a = row({ key: "ENG-1", section: "review", pr: 11 });
  const b = row({ key: "ENG-2", section: "tasks" });
  const c = row({ key: "ENG-3", section: "review", pr: 12 });
  const d = row({ key: "ENG-4", section: "merge", pr: 13 });
  const e = row({ key: "ENG-5", section: "merge", pr: 14, terminal: true });
  const { review, merge, tasks } = partitionRows([a, b, c, d, e]);
  assert.deepEqual(review.map((r) => r.key), ["ENG-1", "ENG-3"]);
  assert.deepEqual(merge.map((r) => r.key), ["ENG-4", "ENG-5"]);
  assert.deepEqual(tasks.map((r) => r.key), ["ENG-2"]);
});

test("partitionRows ignores status: a queued PR being fixed stays in the merge pane", () => {
  const a = row({ key: "ENG-1", section: "merge", status: "fixing CI", pr: 13 });
  const b = row({ key: "ENG-2", section: "review", status: "addressing review", pr: 14 });
  const { review, merge, tasks } = partitionRows([a, b]);
  assert.deepEqual(merge.map((r) => r.key), ["ENG-1"]);
  assert.deepEqual(review.map((r) => r.key), ["ENG-2"]);
  assert.deepEqual(tasks, []);
});

test("applyOrder sorts rows by the order entries and carries their reasons", () => {
  const a = row({ key: "ENG-1", status: "draft pr", pr: 11 });
  const c = row({ key: "ENG-3", status: "draft pr", pr: 12 });
  const out = applyOrder([a, c], [{ pr: 12, reason: "base" }, { pr: 11, reason: "on top" }]);
  assert.deepEqual(out.map((e) => e.row.pr), [12, 11]);
  assert.deepEqual(out.map((e) => e.reason), ["base", "on top"]);
});

test("applyOrder with no order yet keeps board order and shows a pending reason", () => {
  const a = row({ key: "ENG-1", status: "draft pr", pr: 11 });
  const c = row({ key: "ENG-3", status: "draft pr", pr: 12 });
  const out = applyOrder([a, c], null);
  assert.deepEqual(out.map((e) => e.row.pr), [11, 12]);
  assert.deepEqual(out.map((e) => e.reason), ["…", "…"]);
});

test("applyOrder appends rows the order forgot, in board order", () => {
  const a = row({ key: "ENG-1", status: "draft pr", pr: 11 });
  const c = row({ key: "ENG-3", status: "draft pr", pr: 12 });
  const d = row({ key: "ENG-4", status: "draft pr", pr: 13 });
  const out = applyOrder([a, c, d], [{ pr: 13, reason: "r" }]);
  assert.deepEqual(out.map((e) => e.row.pr), [13, 11, 12]);
  assert.deepEqual(out.map((e) => e.reason), ["r", "…", "…"]);
});

test("applyOrder keeps a row without a PR at the end rather than dropping it", () => {
  const a = row({ key: "ENG-1", status: "draft pr", pr: 11 });
  const weird = row({ key: "ENG-9", status: "draft pr", pr: undefined });
  const out = applyOrder([a, weird], [{ pr: 11, reason: "r" }]);
  assert.deepEqual(out.map((e) => e.row.key), ["ENG-1", "ENG-9"]);
});

test("boardLayout reserves an equal third of the body for every pane", () => {
  const l = boardLayout(24);
  // Body is 22 rows (title + footer), a third is 7; tasks keeps the remainder.
  assert.equal(l.merge.height, 7);
  assert.equal(l.merge.bottom, 1);
  assert.equal(l.review.height, 7);
  assert.equal(l.review.bottom, 8);
  assert.deepEqual(l.tasks, { top: 1, left: 0, right: 0, bottom: 15 });
});

test("boardLayout keeps every pane at least one visible row on a tiny screen", () => {
  const l = boardLayout(10);
  assert.equal(l.merge.height, 4);
  assert.equal(l.review.height, 4);
});

test("movePane moves up and down the stack, skipping empty panes", () => {
  const all: PaneCounts = { tasks: 2, review: 1, merge: 1 };
  assert.equal(movePane("tasks", "down", all), "review");
  assert.equal(movePane("review", "down", all), "merge");
  assert.equal(movePane("merge", "up", all), "review");
  assert.equal(movePane("review", "up", all), "tasks");
  // Edges stay put.
  assert.equal(movePane("tasks", "up", all), "tasks");
  assert.equal(movePane("merge", "down", all), "merge");
  // Empty panes are skipped over, not landed on.
  assert.equal(movePane("tasks", "down", { tasks: 2, review: 0, merge: 1 }), "merge");
  assert.equal(movePane("merge", "up", { tasks: 2, review: 0, merge: 1 }), "tasks");
  assert.equal(movePane("tasks", "down", { tasks: 2, review: 0, merge: 0 }), "tasks");
});

test("nextPane cycles tasks, review, merge and skips empty panes", () => {
  const all: PaneCounts = { tasks: 1, review: 1, merge: 1 };
  assert.equal(nextPane("tasks", all), "review");
  assert.equal(nextPane("review", all), "merge");
  assert.equal(nextPane("merge", all), "tasks");
  assert.equal(nextPane("tasks", { tasks: 1, review: 0, merge: 1 }), "merge");
  assert.equal(nextPane("tasks", { tasks: 1, review: 0, merge: 0 }), "tasks");
});

test("paneBorderColor gives each pane its own outline and white to the focused one", () => {
  assert.equal(paneBorderColor("tasks", false), "grey");
  assert.equal(paneBorderColor("review", false), "yellow");
  assert.equal(paneBorderColor("merge", false), "green");
  assert.equal(paneBorderColor("review", true), "white");
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

test("the pane-switch keys moved to the help overlay", () => {
  assert.ok(helpLines("Y").join("\n").includes("^j/^k"));
});

test("footerHint fits a 130-column terminal so the tail hints survive wrap:false", () => {
  assert.ok(footerHint("review").length <= 130, `footer is ${footerHint("review").length} chars`);
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

test("selectedBoardRow reads from the focused pane's own selection", () => {
  const a = row({ key: "ENG-1", status: "draft pr", pr: 11 });
  const b = row({ key: "ENG-2", status: "working" });
  const c = row({ key: "ENG-3", status: "ready to merge", pr: 13 });
  const panes = {
    tasks: { rows: [b], selected: 1 },
    review: { entries: [{ row: a, reason: "" }], selected: 1 },
    merge: { rows: [c], selected: 1 },
  };
  assert.equal(selectedBoardRow("review", panes), a);
  assert.equal(selectedBoardRow("tasks", panes), b);
  assert.equal(selectedBoardRow("merge", panes), c);
  assert.equal(selectedBoardRow("review", { ...panes, review: { entries: [], selected: 1 } }), undefined);
  assert.equal(selectedBoardRow("tasks", { ...panes, tasks: { rows: [], selected: 1 } }), undefined);
});



test("resolvePane forces a pane with rows when the current one is empty", () => {
  assert.equal(resolvePane("tasks", { tasks: 0, review: 2, merge: 0 }), "review");
  assert.equal(resolvePane("review", { tasks: 3, review: 0, merge: 0 }), "tasks");
  assert.equal(resolvePane("merge", { tasks: 0, review: 0, merge: 1 }), "merge");
  assert.equal(resolvePane("review", { tasks: 2, review: 2, merge: 0 }), "review");
  assert.equal(resolvePane("tasks", { tasks: 0, review: 0, merge: 2 }), "merge");
  assert.equal(resolvePane("review", { tasks: 0, review: 0, merge: 0 }), "tasks");
});

test("bindPaneFocusSync tracks blessed focus, so a mouse click that moves focus moves the pane", () => {
  const { input, output } = fakeTty(80, 24);
  const screen = blessed.screen({ input, output, terminal: "xterm", smartCSR: true });
  const tasks = blessed.listtable({ parent: screen, top: 5, height: 5, keys: true, mouse: true });
  const review = blessed.listtable({ parent: screen, top: 0, height: 5, keys: true, mouse: true });
  const merge = blessed.listtable({ parent: screen, top: 10, height: 5, keys: true, mouse: true });
  let pane = "tasks";
  bindPaneFocusSync({ tasks, review, merge }, (p) => { pane = p; });
  review.focus(); // what neo-blessed list.js does on item mousedown
  assert.equal(pane, "review");
  merge.focus();
  assert.equal(pane, "merge");
  tasks.focus();
  assert.equal(pane, "tasks");
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

test("alignTables pads every cell to the widest in its column across all tables", () => {
  const [a, b] = alignTables([
    [["TIME", "STATUS"], ["09:14", "working"]],
    [["TIME", "STATUS"], ["10:02", "ready to merge"]],
  ]);
  assert.deepEqual(a, [["TIME ", "STATUS        "], ["09:14", "working       "]]);
  assert.deepEqual(b, [["TIME ", "STATUS        "], ["10:02", "ready to merge"]]);
});

test("alignTables pads by visible width so tagged cells line up with plain ones", () => {
  const [a] = alignTables([[["{grey-fg}merged{/grey-fg}"], ["ready to merge"]]]);
  assert.equal(cellWidth(a[0][0]), 14);
  assert.equal(cellWidth(a[1][0]), 14);
});

test("alignTables gives an empty pane the same widths as a busy one", () => {
  // A pane with no rows still renders its header, and that header has to sit on
  // the same grid as the panes that do have rows.
  const [empty, busy] = alignTables([
    [BOARD_HEADER],
    boardTable([{ row: row({ status: "resolving conflict", title: "a long branch title" }) }], 0),
  ]);
  assert.deepEqual(empty[0].map(cellWidth), busy[0].map(cellWidth));
});

// The alignment claim, checked against blessed itself rather than against the
// padded strings: render three panes carrying very different content and assert
// every column starts at the same screen offset in all three.
test("the three panes render their columns on identical offsets", () => {
  const { input, output } = fakeTty(200, 30);
  const screen = blessed.screen({ input, output, terminal: "xterm", smartCSR: true, fullUnicode: true });
  const make = (top: number) =>
    blessed.listtable({
      parent: screen, top, left: 0, right: 0, height: 6,
      tags: true, align: "left", keys: true, vi: true, mouse: true,
      border: { type: "line" }, noCellBorders: true,
      style: { header: { bold: true }, cell: { selected: { inverse: true } } },
    });
  const panes = [make(0), make(6), make(12)];
  const data = alignTables([
    boardTable([{ row: row({ label: "ENG-1", status: "resolving conflict", title: "a much longer branch title" }) }], 0),
    boardTable([{ row: row({ label: "SC-22", pr: 4712, status: "draft pr" }), why: "base of the stack" }], 0),
    boardTable([], 0),
  ]);
  panes.forEach((p, i) => p.setData(data[i]));
  screen.render();
  const lines: string[] = screen.lines.map((line: [number, string][]) => line.map((c) => c[1]).join(""));
  // Header row of each pane: one row below its border.
  const headers = [lines[1], lines[7], lines[13]];
  const offsets = headers.map((h) => BOARD_HEADER.map((col) => h.indexOf(col)));
  assert.ok(offsets[0].every((o) => o > 0), `header not rendered: ${headers[0]}`);
  assert.deepEqual(offsets[1], offsets[0]);
  assert.deepEqual(offsets[2], offsets[0]);
  screen.destroy();
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

test("alignTables keeps wide-character titles on the shared grid", () => {
  const [a, b] = alignTables([
    boardTable([{ row: row({ title: "需要审核" }) }], 0),
    boardTable([{ row: row({ title: "ok" }) }], 0),
  ]);
  const titleIdx = BOARD_HEADER.indexOf("TITLE");
  assert.equal(cellWidth(a[1][titleIdx]), cellWidth(b[1][titleIdx]));
});
