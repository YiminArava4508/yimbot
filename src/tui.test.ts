import assert from "node:assert/strict";
import { test } from "node:test";
import { rowsToTable } from "./tui.ts";
import type { BoardRow } from "./events.ts";

const row = (over: Partial<BoardRow>): BoardRow => ({
  key: "ENG-1",
  label: "ENG-1",
  status: "working",
  terminal: false,
  ts: 0,
  ...over,
});

test("rowsToTable header has a PR column between TICKET and TITLE", () => {
  assert.deepEqual(rowsToTable([])[0], ["TIME", "STATUS", "TICKET", "PR", "TITLE"]);
});

test("rowsToTable renders #N in the PR column when pr is set", () => {
  const [, body] = rowsToTable([row({ pr: 481, title: "add column" })]);
  assert.equal(body[3], "#481");
  assert.equal(body[4], "add column");
});

test("rowsToTable leaves the PR cell blank when pr is absent", () => {
  const [, body] = rowsToTable([row({})]);
  assert.equal(body[3], "");
});
