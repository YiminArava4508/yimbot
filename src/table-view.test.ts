import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import blessed from "neo-blessed";
import { cellWidth } from "./board-format.ts";
import type { BoardRow } from "./events.ts";
import { QUEUE_PANE_WIDTH } from "./heavy-queue.ts";
import {
  alignTables,
  applyOrder,
  BOARD_HEADER,
  boardTable,
  partitionTable,
  tableBoxes,
  tableFocusOrder,
} from "./table-view.ts";

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
    "TIME", "DUR", "STATUS", "TICKET", "PR", "REPO", "TITLE", "FLAG", "REASON",
  ]);
  assert.deepEqual(boardTable([])[0], BOARD_HEADER);
});

test("boardTable renders #N in the PR column and the title", () => {
  const [, body] = boardTable([{ row: row({ pr: 481, title: "add column" }) }], 0);
  assert.equal(body[4], "#481");
  assert.equal(body[6], "add column");
});

test("boardTable prefixes a research title with a magenta type chip, plain titles untouched", () => {
  const [, research, plain] = boardTable(
    [{ row: row({ title: "Decide retention for exports" }) }, { row: row({ title: "add column" }) }],
    0,
  );
  assert.equal(research[6], "{magenta-fg}[research]{/magenta-fg} Decide retention for exports");
  assert.equal(plain[6], "add column");
});

test("boardTable prefixes a ticketless PR row with a cyan pr chip", () => {
  const [, pr] = boardTable([{ row: row({ key: "pr:7117", label: "PR #7117", pr: 7117, title: "test extract coverage" }) }], 0);
  assert.equal(pr[6], "{cyan-fg}[pr]{/cyan-fg} test extract coverage");
});

test("boardTable fills REPO from the extra repo slug name, the codebase name for codebase PRs, blank without a PR", () => {
  const extra = boardTable([{ row: row({ pr: 1507, repo: "acme/terraform-x" }) }], 0, "gemini")[1];
  assert.equal(extra[5], "{grey-fg}terraform-x{/grey-fg}");
  const codebase = boardTable([{ row: row({ pr: 5970 }) }], 0, "gemini")[1];
  assert.equal(codebase[5], "{grey-fg}gemini{/grey-fg}");
  const none = boardTable([{ row: row({}) }], 0, "gemini")[1];
  assert.equal(none[5], "");
});

test("boardTable leaves the PR cell blank when pr is absent", () => {
  const [, body] = boardTable([{ row: row({}) }], 0);
  assert.equal(body[4], "");
});

test("boardTable DUR uses now - startTs for an active row", () => {
  const [, body] = boardTable([{ row: row({ startTs: 0, ts: 0 }) }], 65_000);
  assert.equal(body[1], "{grey-fg}1m{/grey-fg}");
});

test("boardTable DUR is frozen at ts - startTs for a terminal row", () => {
  const [, body] = boardTable([{ row: row({ terminal: true, startTs: 0, ts: 60_000 }) }], 999_999);
  assert.equal(body[1], "{grey-fg}1m{/grey-fg}");
});

test("boardTable marks a flagged row and leaves others blank", () => {
  const [, flagged] = boardTable([{ row: row({ flagged: true, flagReasons: ["manual"] }) }], 0);
  assert.equal(flagged[7], "{red-fg}⚑{/red-fg}");
  const [, plain] = boardTable([{ row: row({}) }], 0);
  assert.equal(plain[7], "");
});

test("boardTable joins the flag reasons in the REASON cell", () => {
  const [, body] = boardTable(
    [{ row: row({ flagged: true, flagReasons: ["input", "changes-requested"] }) }],
    0,
  );
  assert.equal(body[8], "{red-fg}input,changes-requested{/red-fg}");
});

test("boardTable leaves the REASON cell blank when unflagged", () => {
  const [, body] = boardTable([{ row: row({}) }], 0);
  assert.equal(body[8], "");
});

test("boardTable dims a terminal row's status", () => {
  const [, body] = boardTable([{ row: row({ status: "merged", terminal: true }) }], 0);
  assert.equal(body[2], "{grey-fg}merged{/grey-fg}");
});

test("boardTable has no column past REASON", () => {
  const [, body] = boardTable([{ row: row({ pr: 11 }) }], 0);
  assert.equal(body.length, BOARD_HEADER.length);
  assert.equal(body.at(-1), "");
});

test("partitionTable splits on the row's section, preserving order", () => {
  const a = row({ key: "ENG-1", section: "review", pr: 11 });
  const b = row({ key: "ENG-2", section: "tasks" });
  const c = row({ key: "ENG-3", section: "review", pr: 12 });
  const d = row({ key: "ENG-4", section: "merge", pr: 13 });
  const e = row({ key: "ENG-5", section: "merge", pr: 14, terminal: true });
  const { review, merge, tasks } = partitionTable([a, b, c, d, e]);
  assert.deepEqual(review.map((r) => r.key), ["ENG-1", "ENG-3"]);
  assert.deepEqual(merge.map((r) => r.key), ["ENG-4", "ENG-5"]);
  assert.deepEqual(tasks.map((r) => r.key), ["ENG-2"]);
});

test("partitionTable lifts split parents out of tasks into their own pane", () => {
  const a = row({ key: "ENG-1", status: "tracker ticket" });
  const b = row({ key: "ENG-2", status: "working" });
  const c = row({ key: "ENG-3", status: "waiting on slices" });
  const d = row({ key: "ENG-4", status: "needs decision" });
  const { tasks, parents, review, merge } = partitionTable([a, b, c, d]);
  assert.deepEqual(parents.map((r) => r.key), ["ENG-1", "ENG-3"]);
  assert.deepEqual(tasks.map((r) => r.key), ["ENG-2", "ENG-4"]);
  assert.deepEqual(review, []);
  assert.deepEqual(merge, []);
});


test("partitionTable puts a parent in its pane over a section its pre-split PR left behind", () => {
  const a = row({ key: "ENG-1", status: "waiting on slices", section: "merge", pr: 7 });
  const { parents, merge } = partitionTable([a]);
  assert.deepEqual(parents.map((r) => r.key), ["ENG-1"]);
  assert.deepEqual(merge, []);
});

test("partitionTable ignores status: a queued PR being fixed stays in the merge pane", () => {
  const a = row({ key: "ENG-1", section: "merge", status: "fixing CI", pr: 13 });
  const b = row({ key: "ENG-2", section: "review", status: "addressing review", pr: 14 });
  const { review, merge, tasks } = partitionTable([a, b]);
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
    boardTable([{ row: row({ label: "SC-22", pr: 4712, status: "draft pr" }) }], 0),
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

test("alignTables keeps wide-character titles on the shared grid", () => {
  const [a, b] = alignTables([
    boardTable([{ row: row({ title: "需要审核" }) }], 0),
    boardTable([{ row: row({ title: "ok" }) }], 0),
  ]);
  const titleIdx = BOARD_HEADER.indexOf("TITLE");
  assert.equal(cellWidth(a[1][titleIdx]), cellWidth(b[1][titleIdx]));
});

test("tableBoxes reserves an equal third of the body for every pane", () => {
  const l = tableBoxes(24, 200);
  assert.equal(l.merge.height, 7);
  assert.equal(l.merge.bottom, 1);
  assert.equal(l.review.height, 7);
  assert.equal(l.review.bottom, 8);
  assert.deepEqual(l.tasks, { top: 1, left: QUEUE_PANE_WIDTH, right: 0, bottom: 15 });
});

test("tableBoxes drops the queue inset on a narrow screen", () => {
  const l = tableBoxes(24, 79);
  assert.equal(l.tasks.left, 0);
  assert.equal(l.review.left, 0);
  assert.equal(l.merge.left, 0);
});

test("tableBoxes keeps one data row visible per pane on a tiny screen", () => {
  assert.equal(tableBoxes(8, 200).review.height, 4);
});

test("tableFocusOrder skips empty panes and appends parents only when present", () => {
  assert.deepEqual(tableFocusOrder({ tasks: 2, review: 0, merge: 1 }, false), ["tasks", "merge"]);
  assert.deepEqual(tableFocusOrder({ tasks: 0, review: 3, merge: 0 }, true), ["review", "parents"]);
  assert.deepEqual(tableFocusOrder({ tasks: 0, review: 0, merge: 0 }, false), []);
  assert.deepEqual(tableFocusOrder({ tasks: 1, review: 1, merge: 1 }, true), ["tasks", "review", "merge", "parents"]);
});
