import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import blessed from "neo-blessed";
import { applyOrder, bindFlagKey, bindModeKey, bindPaneFocusSync, bindPaneNavKeys, bindPaneToggle, bindQuitKeys, bindReadyKey, bindReviewKey, bindSettingsKey, boardLayout, fmtDuration, footerHint, footerLayout, handleReadyPress, mergeTable, modeContent, movePane, nextPane, paneBorderColor, partitionRows, resolvePane, reviewOnlyGuard, returnKey, reviewTable, rowsToTable, screenTerm, selectedBoardRow, statusContent, type PaneCounts } from "./tui.ts";
import type { BoardRow } from "./events.ts";

const row = (over: Partial<BoardRow>): BoardRow => ({
  key: "ENG-1",
  label: "ENG-1",
  status: "working",
  terminal: false,
  ts: 0,
  startTs: 0,
  flagged: false,
  flagReasons: [],
  ...over,
});

test("rowsToTable header has DUR at index 1 and REASON last", () => {
  assert.deepEqual(rowsToTable([])[0], [
    "TIME", "DUR", "STATUS", "TICKET", "PR", "TITLE", "FLAG", "REASON",
  ]);
});

test("rowsToTable renders #N in the PR column and the title", () => {
  const [, body] = rowsToTable([row({ pr: 481, title: "add column" })], 0);
  assert.equal(body[4], "#481");
  assert.equal(body[5], "add column");
});

test("rowsToTable leaves the PR cell blank when pr is absent", () => {
  const [, body] = rowsToTable([row({})], 0);
  assert.equal(body[4], "");
});

test("rowsToTable DUR uses now - startTs for an active row", () => {
  const [, body] = rowsToTable([row({ startTs: 0, ts: 0 })], 65_000);
  assert.equal(body[1], "1m");
});

test("rowsToTable DUR is frozen at ts - startTs for a terminal row", () => {
  const [, body] = rowsToTable(
    [row({ terminal: true, startTs: 0, ts: 60_000 })],
    999_999,
  );
  assert.equal(body[1], "1m");
});

test("rowsToTable marks a flagged row and leaves others blank", () => {
  const [, flagged] = rowsToTable([row({ flagged: true, flagReasons: ["manual"] })], 0);
  assert.equal(flagged[6], "{red-fg}⚑{/red-fg}");
  const [, plain] = rowsToTable([row({})], 0);
  assert.equal(plain[6], "");
});

test("rowsToTable joins the flag reasons in the REASON cell", () => {
  const [, body] = rowsToTable(
    [row({ flagged: true, flagReasons: ["input", "changes-requested"] })],
    0,
  );
  assert.equal(body[7], "{red-fg}input,changes-requested{/red-fg}");
});

test("rowsToTable leaves the REASON cell blank when unflagged", () => {
  const [, body] = rowsToTable([row({})], 0);
  assert.equal(body[7], "");
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

test("footerHint keeps the existing hints and names the return key in every pane", () => {
  for (const pane of ["tasks", "review", "merge"] as const) {
    const hint = footerHint("F12", pane);
    assert.match(hint, /j\/k move/);
    assert.match(hint, /enter open/);
    assert.match(hint, /f flag\/unflag/);
    assert.match(hint, /m mode/);
    assert.match(hint, /q quit/);
    assert.match(hint, /prefix\+F12 returns here/);
  }
});

test("footerHint shows r/R only for the review pane, matching where they act", () => {
  assert.match(footerHint("Y", "review"), /r ready {3}R review/);
  assert.doesNotMatch(footerHint("Y", "tasks"), /r ready|R review/);
  assert.doesNotMatch(footerHint("Y", "merge"), /r ready|R review/);
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

test("footerHint advertises the settings key", () => {
  assert.match(footerHint("Y", "tasks"), /s settings/);
});

test("footerHint no longer advertises a refine key (refine lives in settings)", () => {
  assert.doesNotMatch(footerHint("Y", "review"), /refine/);
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
  bindQuitKeys(fakeScreen, () => settingsOpen, () => quitCalls++);

  handlers["q"]();
  handlers["escape"]();
  assert.equal(quitCalls, 0, "q and escape must not quit while the panel is open");

  handlers["C-c"]();
  assert.equal(quitCalls, 1, "C-c must quit even while the panel is open");

  settingsOpen = false;
  handlers["q"]();
  assert.equal(quitCalls, 2, "q quits again once the panel is closed");
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

test("footerHint advertises the manual ready-label key", () => {
  assert.match(footerHint("Y", "review"), /r ready/);
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
function renderBoardLines(columns: number, rows: number, key: string): string[] {
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
  blessed.text({ parent: screen, ...footerLayout(key) });
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
  const lines = renderBoardLines(columns, rows, returnKey());
  // table is `bottom: 1`, so its content fills up to one row above the
  // screen's last row; that row must still show a ticket, not footer text.
  const lastTableRow = lines[rows - 2];
  assert.match(lastTableRow, /ENG-\d+/, "the table's last row must survive, not be painted over");
  assert.doesNotMatch(lastTableRow, /returns here/);
  // the footer itself is confined to the final row, clipped rather than
  // spilling onto a second line.
  assert.equal(lines.length, rows);
});

test("footer clips at a narrow width with a long custom key, still sparing the table's last row", () => {
  const columns = 60;
  const rows = 20;
  const lines = renderBoardLines(columns, rows, "C-M-Space"); // 95-char hint, well past 60 columns
  const lastTableRow = lines[rows - 2];
  assert.match(lastTableRow, /ENG-\d+/, "the table's last row must survive, not be painted over");
  assert.equal(lines.length, rows);
});

test("footerHint names the review key", () => {
  assert.ok(footerHint("Y", "review").includes("R review"));
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

test("partitionRows splits draft-pr, ready-to-merge and merged rows from the tasks, preserving order", () => {
  const a = row({ key: "ENG-1", status: "draft pr", pr: 11 });
  const b = row({ key: "ENG-2", status: "working" });
  const c = row({ key: "ENG-3", status: "draft pr", pr: 12 });
  const d = row({ key: "ENG-4", status: "ready to merge", pr: 13 });
  const e = row({ key: "ENG-5", status: "merged", pr: 14, terminal: true });
  const { review, merge, tasks } = partitionRows([a, b, c, d, e]);
  assert.deepEqual(review.map((r) => r.key), ["ENG-1", "ENG-3"]);
  assert.deepEqual(merge.map((r) => r.key), ["ENG-4", "ENG-5"]);
  assert.deepEqual(tasks.map((r) => r.key), ["ENG-2"]);
});

test("mergeTable renders PR, ticket, title, status, wait time and flag columns", () => {
  const a = row({
    key: "ENG-4", label: "ENG-4", status: "ready to merge", pr: 13, title: "bump deps", ts: 60_000,
    flagged: true, flagReasons: ["ci"],
  });
  const t = mergeTable([a], 120_000);
  assert.deepEqual(t[0], ["PR", "TICKET", "TITLE", "STATUS", "WAIT", "FLAG", "REASON"]);
  assert.deepEqual(t[1], ["#13", "ENG-4", "bump deps", "ready to merge", "1m", "{red-fg}⚑{/red-fg}", "{red-fg}ci{/red-fg}"]);
});

test("mergeTable dims a merged row's status like the tasks pane does", () => {
  const a = row({ key: "ENG-5", label: "ENG-5", status: "merged", pr: 14, terminal: true });
  const [, body] = mergeTable([a], 0);
  assert.equal(body[3], "{grey-fg}merged{/grey-fg}");
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

test("reviewTable numbers entries from 1 and renders PR, ticket, title, wait time and reason", () => {
  const a = row({ key: "ENG-1", label: "ENG-1", status: "draft pr", pr: 11, title: "client", ts: 60_000 });
  const t = reviewTable([{ row: a, reason: "base of the stack" }], 120_000);
  assert.deepEqual(t[0], ["#", "PR", "TICKET", "TITLE", "WAIT", "FLAG", "REASON", "WHY"]);
  assert.deepEqual(t[1], ["1", "#11", "ENG-1", "client", "1m", "", "", "base of the stack"]);
});

test("reviewTable keeps the flag marker and reasons visible for flagged drafts", () => {
  const a = row({
    key: "ENG-1", label: "ENG-1", status: "draft pr", pr: 11,
    flagged: true, flagReasons: ["input"],
  });
  const [, body] = reviewTable([{ row: a, reason: "r" }], 0);
  assert.equal(body[5], "{red-fg}⚑{/red-fg}");
  assert.equal(body[6], "{red-fg}input{/red-fg}");
});

test("boardLayout with no merge rows runs both columns down to the footer", () => {
  const l = boardLayout(0, 24);
  assert.equal(l.merge, null);
  assert.deepEqual(l.tasks, { top: 1, left: 0, width: "50%", bottom: 1 });
  assert.deepEqual(l.review, { top: 1, left: "50%", right: 0, bottom: 1 });
});

test("boardLayout sizes the merge pane to its rows and lifts the columns above it", () => {
  const l = boardLayout(2, 24);
  assert.ok(l.merge);
  // 2 rows + column header + 2 border rows.
  assert.equal(l.merge.height, 5);
  assert.equal(l.merge.bottom, 1);
  assert.equal(l.tasks.bottom, 6);
  assert.equal(l.review.bottom, 6);
});

test("boardLayout caps the merge pane at a third of the screen so the columns keep room", () => {
  const l = boardLayout(20, 24);
  assert.equal(l.merge?.height, 8);
  assert.equal(l.tasks.bottom, 9);
  // Even on a tiny screen the pane keeps one visible row.
  assert.equal(boardLayout(20, 10).merge?.height, 4);
});

test("movePane moves between the columns and the merge pane, skipping empty targets", () => {
  const all: PaneCounts = { tasks: 2, review: 1, merge: 1 };
  assert.equal(movePane("tasks", "right", all), "review");
  assert.equal(movePane("review", "left", all), "tasks");
  assert.equal(movePane("tasks", "down", all), "merge");
  assert.equal(movePane("review", "down", all), "merge");
  assert.equal(movePane("merge", "up", all), "tasks");
  // Edges stay put.
  assert.equal(movePane("tasks", "left", all), "tasks");
  assert.equal(movePane("review", "right", all), "review");
  assert.equal(movePane("merge", "down", all), "merge");
  // Empty targets are not focusable.
  assert.equal(movePane("tasks", "right", { tasks: 2, review: 0, merge: 1 }), "tasks");
  assert.equal(movePane("tasks", "down", { tasks: 2, review: 1, merge: 0 }), "tasks");
  // Up from merge prefers tasks but falls back to review.
  assert.equal(movePane("merge", "up", { tasks: 0, review: 1, merge: 1 }), "review");
  assert.equal(movePane("merge", "up", { tasks: 0, review: 0, merge: 1 }), "merge");
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

test("bindPaneNavKeys maps ctrl-hjkl (and their control-char aliases) to moves, gated by overlays", () => {
  const handlers: Record<string, () => void> = {};
  const screen = { key: (keys: string[], fn: () => void) => { for (const k of keys) handlers[k] = fn; } };
  const moves: string[] = [];
  let overlay = false;
  bindPaneNavKeys(screen, () => overlay, (dir) => moves.push(dir));
  handlers["C-h"]();
  handlers["C-l"]();
  handlers["C-j"]();
  handlers["C-k"]();
  assert.deepEqual(moves, ["left", "right", "down", "up"]);
  // Ctrl+H arrives as backspace and Ctrl+J as linefeed in most terminals.
  handlers["backspace"]();
  handlers["linefeed"]();
  assert.deepEqual(moves.slice(4), ["left", "down"]);
  overlay = true;
  handlers["C-l"]();
  assert.equal(moves.length, 6);
});

test("footerHint advertises the pane-switch keys", () => {
  assert.ok(footerHint("Y", "merge").includes("^hjkl/tab pane"));
});

test("footerHint fits a 130-column terminal so the tail hints survive wrap:false", () => {
  assert.ok(footerHint("Y", "review").length <= 130, `footer is ${footerHint("Y", "review").length} chars`);
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

test("reviewOnlyGuard blocks r/R outside the review pane with a notice", () => {
  assert.equal(reviewOnlyGuard("review"), null);
  assert.match(reviewOnlyGuard("tasks") ?? "", /ready to review pane/);
  assert.match(reviewOnlyGuard("merge") ?? "", /ready to review pane/);
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
