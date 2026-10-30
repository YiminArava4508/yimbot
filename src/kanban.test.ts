import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardRow } from "./events.ts";
import type { CycleBoard } from "./linear-api.ts";
import { cellWidth, fmtDuration } from "./board-format.ts";
import { buildColumns, cardLines, columnColor, cycleFocus, focusOrder, pickRow, statusTone, stepFocus, visibleWindow, type Card } from "./kanban.ts";

function row(over: Partial<BoardRow> = {}): BoardRow {
  return {
    key: "k",
    label: "ENG-1",
    status: "coding",
    terminal: false,
    section: "tasks",
    ts: 0,
    startTs: 0,
    flagged: false,
    flagReasons: [],
    ...over,
  };
}

function board(over: Partial<CycleBoard> = {}): CycleBoard {
  return {
    cycleNumber: 1,
    states: [
      { id: "s-done", name: "Done", type: "completed", position: 0, color: "#5e6ad2" },
      { id: "s-review", name: "In Review", type: "started", position: 2, color: "#f2994a" },
      { id: "s-todo", name: "Todo", type: "unstarted", position: 0, color: "#e2e2e2" },
      { id: "s-prog", name: "In Progress", type: "started", position: 1, color: "#f2c94c" },
      { id: "s-back", name: "Backlog", type: "backlog", position: 0, color: "#bec2c8" },
      { id: "s-triage", name: "Triage", type: "triage", position: 0, color: "#ff00ff" },
      { id: "s-cancel", name: "Canceled", type: "canceled", position: 0, color: "#95a2b3" },
    ],
    issues: [],
    ...over,
  };
}

const issue = (identifier: string, stateId: string, sortOrder = 0) => ({
  identifier,
  title: `title ${identifier}`,
  stateId,
  sortOrder,
  estimate: null,
});

test("buildColumns orders states by type group then position", () => {
  const cols = buildColumns(board(), []);
  assert.deepEqual(
    cols.map((c) => c.title),
    ["Backlog", "Todo", "In Progress", "In Review", "Done"],
  );
});

test("columnColor uses the Linear hex when valid", () => {
  assert.equal(columnColor({ type: "started", color: "#f2c94c" }), "#f2c94c");
  assert.equal(columnColor({ type: "started", color: "#ABCDEF" }), "#ABCDEF");
});

test("columnColor falls back by state type", () => {
  const table: Record<string, string> = {
    triage: "magenta",
    backlog: "grey",
    unstarted: "white",
    started: "yellow",
    completed: "green",
    canceled: "red",
    mystery: "grey",
  };
  for (const [type, want] of Object.entries(table)) {
    assert.equal(columnColor({ type, color: "" }), want, type);
  }
});

test("columnColor falls back when the hex is malformed", () => {
  for (const color of ["red", "#fff", ""]) {
    assert.equal(columnColor({ type: "started", color }), "yellow", color);
  }
});

test("buildColumns gives each column its color", () => {
  const cols = buildColumns(board(), []);
  const byTitle = Object.fromEntries(cols.map((c) => [c.title, c.color]));
  assert.equal(byTitle["In Progress"], "#f2c94c");
  assert.equal(byTitle["Todo"], "#e2e2e2");
});

test("buildColumns keeps empty states but hides empty triage and canceled columns", () => {
  const cols = buildColumns(board(), []);
  assert.ok(cols.some((c) => c.title === "Done" && c.cards.length === 0));
  assert.ok(!cols.some((c) => c.title === "Triage" || c.title === "Canceled"));
  const withCanceled = buildColumns(board({ issues: [issue("ENG-9", "s-cancel")] }), []);
  assert.equal(withCanceled.at(-1)?.title, "Canceled");
  const withTriage = buildColumns(board({ issues: [issue("ENG-8", "s-triage")] }), []);
  assert.equal(withTriage[0]?.title, "Triage");
});

test("buildColumns places each issue in its state's column by Linear state, sorted by sortOrder", () => {
  const cols = buildColumns(
    board({
      issues: [
        issue("ENG-3", "s-prog", 30),
        issue("ENG-1", "s-prog", 10),
        issue("ENG-2", "s-todo", 5),
        issue("ENG-4", "s-prog", 20),
      ],
    }),
    [],
  );
  const byTitle = Object.fromEntries(cols.map((c) => [c.title, c.cards.map((k) => k.key)]));
  assert.deepEqual(byTitle["In Progress"], ["ENG-1", "ENG-4", "ENG-3"]);
  assert.deepEqual(byTitle["Todo"], ["ENG-2"]);
  assert.equal(cols.find((c) => c.title === "Todo")?.id, "s-todo");
});

test("buildColumns never moves a card because of its yimbot row", () => {
  const r = row({ label: "ENG-1", section: "review" });
  const cols = buildColumns(board({ issues: [issue("ENG-1", "s-prog")] }), [r]);
  const prog = cols.find((c) => c.title === "In Progress");
  assert.equal(prog?.cards.length, 1);
  assert.equal(prog?.cards[0]?.row, r);
  assert.equal(cols.find((c) => c.title === "In Review")?.cards.length, 0);
});

test("pickRow matches rows by label and prefers the non-terminal row over a terminal one", () => {
  const done = row({ key: "a", label: "ENG-1", terminal: true });
  const live = row({ key: "b", label: "ENG-1", terminal: false });
  const other = row({ key: "c", label: "ENG-2" });
  assert.equal(pickRow([done, other, live], "ENG-1"), live);
  assert.equal(pickRow([done], "ENG-1"), done);
  assert.equal(pickRow([other], "ENG-1"), null);
});

test("a card with no yimbot row has row null and its Linear state name in stateName", () => {
  const cols = buildColumns(board({ issues: [issue("ENG-5", "s-review")] }), []);
  const card = cols.find((c) => c.title === "In Review")?.cards[0];
  assert.equal(card?.row, null);
  assert.equal(card?.stateName, "In Review");
  assert.equal(card?.title, "title ENG-5");
});

const strip = (line: string) => line.replace(/\{[^}]*\}/g, "");
const card = (over: Partial<Card> = {}): Card => ({
  key: "ENG-1",
  title: "Fix the thing",
  stateName: "In Progress",
  row: row({ repo: undefined }),
  ...over,
});

test("cardLines puts the key first, then the age for a live row", () => {
  const lines = cardLines(card({ row: row({ startTs: 1000 }) }), 30, 1000 + 5 * 60_000, "codebase");
  assert.ok(lines[0].startsWith("ENG-1"));
  assert.ok(lines[0].includes(`{grey-fg}${fmtDuration(5 * 60_000)}{/grey-fg}`));
});

test("cardLines shows #PR instead of the age once the row has a PR", () => {
  const lines = cardLines(card({ row: row({ pr: 42, startTs: 0 }) }), 30, 60_000, "codebase");
  assert.ok(lines[0].includes("#42"));
  assert.ok(!lines[0].includes(fmtDuration(60_000)));
});

test("cardLines marks a flagged row with the red flag", () => {
  const flagged = cardLines(card({ row: row({ flagged: true, flagReasons: ["x"] }) }), 30, 0, "c");
  assert.ok(flagged[0].includes("{red-fg}⚑{/red-fg}"));
  assert.ok(!cardLines(card(), 30, 0, "c")[0].includes("⚑"));
});

test("cardLines status line reads only the section label while the row's status is a readiness claim", () => {
  const status = (r: BoardRow) => strip(cardLines(card({ row: r }), 40, 0, "c").at(-1) ?? "");
  assert.equal(status(row({ section: "review", status: "draft pr" })), "ready to review");
  assert.equal(status(row({ section: "merge", status: "ready to merge" })), "ready to merge");
  assert.equal(status(row({ section: "merge", status: "ready: r to queue" })), "ready to merge");
});

test("cardLines status line reads a merged or held row as its own status, not ready to merge", () => {
  const status = (r: BoardRow) => strip(cardLines(card({ row: r }), 40, 0, "c").at(-1) ?? "");
  assert.equal(status(row({ section: "merge", status: "merged", terminal: true })), "merged");
  assert.equal(status(row({ section: "merge", status: "merged, waiting on slices" })), "merged, waiting on slices");
  assert.equal(status(row({ section: "review", status: "qa posted", terminal: true })), "qa posted");
});

test("cardLines status line adds in-section progress after the section label", () => {
  const status = (r: BoardRow) => strip(cardLines(card({ row: r }), 40, 0, "c").at(-1) ?? "");
  assert.equal(status(row({ section: "merge", status: "CI failing" })), "ready to merge, CI failing");
  assert.equal(status(row({ section: "merge", status: "merge queue blocked" })), "ready to merge, merge queue blocked");
  assert.equal(status(row({ section: "review", status: "addressing review" })), "ready to review, addressing review");
  assert.equal(status(row({ section: "tasks", status: "coding" })), "coding");
});

test("cardLines freezes a terminal row's age at its last event", () => {
  const done = row({ terminal: true, status: "refined", startTs: 0, ts: 10 * 60_000 });
  const lines = cardLines(card({ row: done }), 30, 60 * 60_000, "c");
  assert.ok(lines[0].includes(`{grey-fg}${fmtDuration(10 * 60_000)}{/grey-fg}`));
  const live = cardLines(card({ row: row({ startTs: 0, ts: 10 * 60_000 }) }), 30, 60 * 60_000, "c");
  assert.ok(live[0].includes(`{grey-fg}${fmtDuration(60 * 60_000)}{/grey-fg}`));
});

test("cardLines shows a split parent's own status and age, never the section or PR its pre-split PR left behind", () => {
  const parent = row({ status: "waiting on slices", section: "merge", pr: 7, startTs: 0 });
  const lines = cardLines(card({ row: parent }), 30, 5 * 60_000, "c");
  assert.ok(!lines[0].includes("#7"));
  assert.ok(lines[0].includes(fmtDuration(5 * 60_000)));
  assert.ok(lines.some((l) => strip(l) === "waiting on slices"));
  assert.ok(!lines.some((l) => strip(l).includes("ready to merge")));
});

test("cardLines for a card with no row shows the Linear state name in grey and no age, flag or repo line", () => {
  const lines = cardLines(card({ row: null, stateName: "Todo" }), 30, 0, "codebase");
  assert.deepEqual(lines, ["ENG-1", "Fix the thing", "{grey-fg}Todo{/grey-fg}"]);
});

test("statusTone maps each emitted status to a tone", () => {
  const table: Record<string, string> = {
    working: "ok",
    "working (manual)": "ok",
    "ci green": "ok",
    "ready to merge": "ok",
    merged: "ok",
    "fixing CI": "ok",
    "addressing review": "ok",
    unblocking: "ok",
    "resolving conflict": "ok",
    refining: "ok",
    "qa: in session": "ok",
    "ready to review": "wait",
    "in review": "wait",
    "draft pr": "wait",
    "ready: r to queue": "wait",
    "waiting on slices": "wait",
    "merged, waiting on slices": "wait",
    "merged, waiting on ticket": "wait",
    "qa: waiting on children": "wait",
    "qa: awaiting deploy": "wait",
    "CI failing": "alert",
    "merge queue blocked": "alert",
    "unresolved threads": "alert",
    "needs input": "alert",
    "needs decision": "alert",
    "review findings": "alert",
    "qa failed": "alert",
    "tracker ticket": "idle",
    refined: "idle",
    "qa posted": "idle",
    coding: "idle",
    "": "idle",
  };
  for (const [status, tone] of Object.entries(table)) assert.equal(statusTone(status, false), tone, status);
});

test("statusTone is alert for a flagged row whatever the status, and the worse part wins a combined status", () => {
  assert.equal(statusTone("working", true), "alert");
  assert.equal(statusTone("coding", true), "alert");
  assert.equal(statusTone("ready to merge, CI failing", false), "alert");
  assert.equal(statusTone("ready to review, addressing review", false), "wait");
  assert.equal(statusTone("ready to merge, working", false), "ok");
  assert.equal(statusTone("ready to merge, coding", false), "ok");
});

test("cardLines colors the key bold in the accent", () => {
  const hex = cardLines(card(), 30, 0, "c", "#f2c94c");
  assert.equal(hex[0], "{bold}{#f2c94c-fg}ENG-1{/#f2c94c-fg}{/bold} {grey-fg}0s{/grey-fg}");
  assert.equal(strip(hex[0]), "ENG-1 0s");
  assert.ok(cardLines(card(), 30, 0, "c", "green")[0].startsWith("{bold}{green-fg}ENG-1{/green-fg}{/bold}"));
});

test("cardLines leaves the key uncolored when no accent is given or the accent is malformed", () => {
  for (const accent of [undefined, "", "#zzz", "red}{", "{bold}"]) {
    const line = cardLines(card({ row: null }), 30, 0, "c", accent)[0];
    assert.equal(line, "ENG-1", String(accent));
  }
});

test("cardLines keeps tags balanced and every line in width with an accent", () => {
  for (const width of [3, 6, 12, 30]) {
    for (const line of cardLines(card({ key: "ENG-123456", row: row({ pr: 42, flagged: true }) }), width, 0, "c", "#f2c94c")) {
      assert.ok(cellWidth(line) <= width, `${width}: ${line}`);
      assert.equal((line.match(/\{[^/}][^}]*\}/g) ?? []).length, (line.match(/\{\/[^}]*\}/g) ?? []).length, line);
    }
  }
});

test("cardLines colors #PR cyan and the age grey", () => {
  assert.ok(cardLines(card({ row: row({ pr: 42 }) }), 30, 0, "c")[0].includes("{cyan-fg}#42{/cyan-fg}"));
  assert.ok(cardLines(card(), 30, 5 * 60_000, "c")[0].includes("{grey-fg}5m{/grey-fg}"));
});

test("cardLines colors the status line by tone", () => {
  const status = (r: BoardRow | null) => cardLines(card({ row: r, stateName: "Todo" }), 40, 0, "c").filter((l) => !l.includes("ENG-1"))[1];
  assert.equal(status(row({ status: "working" })), "{green-fg}working{/green-fg}");
  assert.equal(status(row({ section: "review", status: "draft pr" })), "{yellow-fg}ready to review{/yellow-fg}");
  assert.equal(status(row({ section: "merge", status: "ready to merge" })), "{green-fg}ready to merge{/green-fg}");
  assert.equal(status(row({ status: "CI failing" })), "{red-fg}CI failing{/red-fg}");
  assert.equal(status(row({ status: "working", flagged: true, flagReasons: ["x"] })), "{red-fg}working{/red-fg}");
  assert.equal(status(row({ status: "coding" })), "{grey-fg}coding{/grey-fg}");
  assert.equal(status(row({ section: "merge", status: "CI failing" })), "{red-fg}ready to merge, CI failing{/red-fg}");
  assert.equal(status(null), "{grey-fg}Todo{/grey-fg}");
});

test("cardLines wraps the title to two lines at width 36 or more and truncates with an ellipsis, one line below 36", () => {
  const title = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi";
  const wide = cardLines(card({ title, row: null }), 36, 0, "c");
  assert.equal(wide.length, 4);
  assert.ok(wide[2].endsWith("…"));
  const narrow = cardLines(card({ title, row: null }), 35, 0, "c");
  assert.equal(narrow.length, 3);
  assert.ok(narrow[1].endsWith("…"));
  const short = cardLines(card({ title: "alpha beta gamma delta epsilon zeta eta", row: null }), 36, 0, "c");
  assert.equal(short.length, 4);
  assert.ok(!short[2].endsWith("…"));
});

test("cardLines keeps every line within width for wide characters", () => {
  const titles = ["日本語のタイトルがとても長い場合の折り返しテスト用文字列です", "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀", "x"];
  for (const width of [20, 35, 36, 50]) {
    for (const title of titles) {
      const withRow = card({ title, row: row({ pr: 1, repo: "o/日本語リポジトリ名前" }) });
      for (const c of [withRow, card({ title, row: null, stateName: "日本語の状態名前" })]) {
        for (const line of cardLines(c, width, 0, "c")) {
          assert.ok(cellWidth(line) <= width, `${line} is wider than ${width}`);
        }
      }
    }
  }
});

test("cardLines keeps the research chip on the first title line and in width", () => {
  const lines = cardLines(card({ title: "research the thing in depth please", row: null }), 36, 0, "c");
  assert.ok(lines[1].startsWith("{magenta-fg}[research]{/magenta-fg}"));
  for (const line of lines) assert.ok(cellWidth(line) <= 36);
});

test("cardLines omits the repo line when the repo is unknown", () => {
  const noPr = cardLines(card({ row: row({ status: "coding" }) }), 30, 0, "codebase");
  assert.equal(noPr.length, 3);
  const withPr = cardLines(card({ row: row({ pr: 3 }) }), 30, 0, "codebase");
  assert.equal(strip(withPr.at(-1) ?? ""), "codebase");
  assert.equal(withPr.length, 4);
});

test("cardLines colors a row status by tone and greys the no-row state name", () => {
  const withRow = cardLines(card({ row: row({ status: "coding" }) }), 30, 0, "c");
  assert.equal(strip(withRow.at(-1) ?? ""), "coding");
  assert.equal(withRow.at(-1), "{grey-fg}coding{/grey-fg}");
  const review = cardLines(card({ row: row({ section: "review", status: "draft pr" }) }), 30, 0, "c");
  assert.equal(strip(review.at(-1) ?? ""), "ready to review");
  assert.equal(review.at(-1), "{yellow-fg}ready to review{/yellow-fg}");
  const noRow = cardLines(card({ row: null, stateName: "Todo" }), 30, 0, "c");
  assert.equal(noRow.at(-1), "{grey-fg}Todo{/grey-fg}");
});

test("cardLines fits the head line to width when the key is long", () => {
  const long = card({ key: "VERYLONGTEAM-123456", row: row({ pr: 12345, flagged: true, flagReasons: ["x"] }) });
  for (const width of [10, 14, 20]) {
    for (const line of cardLines(long, width, 0, "c")) {
      assert.ok(cellWidth(line) <= width, `${line} is wider than ${width}`);
    }
  }
});

const col = (id: string) => ({ id, title: id, color: "grey", cards: [] });

test("focusOrder appends parents only when there are parents", () => {
  assert.deepEqual(focusOrder([col("a"), col("b")], false), ["a", "b"]);
  assert.deepEqual(focusOrder([col("a"), col("b")], true), ["a", "b", "parents"]);
});

test("stepFocus moves left to right and stops at the ends; an unknown current starts at the first", () => {
  const order = ["a", "b", "c"];
  assert.equal(stepFocus(order, "a", "next"), "b");
  assert.equal(stepFocus(order, "c", "next"), "c");
  assert.equal(stepFocus(order, "b", "prev"), "a");
  assert.equal(stepFocus(order, "a", "prev"), "a");
  assert.equal(stepFocus(order, "zzz", "next"), "a");
  assert.equal(stepFocus(order, "zzz", "prev"), "a");
});

test("cycleFocus wraps from last to first", () => {
  const order = ["a", "b", "c"];
  assert.equal(cycleFocus(order, "a"), "b");
  assert.equal(cycleFocus(order, "c"), "a");
  assert.equal(cycleFocus(order, "zzz"), "a");
});

test("visibleWindow fits floor(width / 24) columns, never fewer than one", () => {
  assert.equal(visibleWindow(10, 0, 0, 100).count, 4);
  assert.equal(visibleWindow(2, 0, 0, 100).count, 2);
  assert.equal(visibleWindow(5, 0, 0, 10).count, 1);
});

test("visibleWindow scrolls minimally to keep the focused column in view", () => {
  assert.equal(visibleWindow(10, 5, 0, 72).start, 3);
  assert.equal(visibleWindow(10, 1, 4, 72).start, 1);
  assert.equal(visibleWindow(10, 5, 4, 72).start, 4);
});

test("visibleWindow gives colWidth of floor(width / count)", () => {
  assert.equal(visibleWindow(10, 0, 0, 100).colWidth, 25);
  assert.equal(visibleWindow(2, 0, 0, 100).colWidth, 50);
});

test("visibleWindow keeps start in range when columns shrink", () => {
  assert.equal(visibleWindow(3, 2, 9, 72).start, 0);
});
