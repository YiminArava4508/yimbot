import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardRow } from "./events.ts";
import type { CycleBoard } from "./linear-api.ts";
import { buildColumns, pickRow } from "./kanban.ts";

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
      { id: "s-done", name: "Done", type: "completed", position: 0 },
      { id: "s-review", name: "In Review", type: "started", position: 2 },
      { id: "s-todo", name: "Todo", type: "unstarted", position: 0 },
      { id: "s-prog", name: "In Progress", type: "started", position: 1 },
      { id: "s-back", name: "Backlog", type: "backlog", position: 0 },
      { id: "s-triage", name: "Triage", type: "triage", position: 0 },
      { id: "s-cancel", name: "Canceled", type: "canceled", position: 0 },
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
