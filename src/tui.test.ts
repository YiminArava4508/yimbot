import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import blessed from "neo-blessed";
import { bindFlagKey, bindModeKey, bindQuitKeys, bindSettingsKey, fmtDuration, footerHint, footerLayout, modeContent, returnKey, rowsToTable } from "./tui.ts";
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

test("footerHint keeps the existing hints and names the return key", () => {
  const hint = footerHint("F12");
  assert.match(hint, /j\/k move/);
  assert.match(hint, /enter open/);
  assert.match(hint, /f flag\/unflag/);
  assert.match(hint, /m mode/);
  assert.match(hint, /q quit/);
  assert.match(hint, /prefix\+F12 returns here/);
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
  assert.match(footerHint("Y"), /s settings/);
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
