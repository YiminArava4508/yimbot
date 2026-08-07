import assert from "node:assert/strict";
import { test } from "node:test";
import { fmtDuration, rowsToTable } from "./tui.ts";
import type { BoardRow } from "./events.ts";

const row = (over: Partial<BoardRow>): BoardRow => ({
  key: "ENG-1",
  label: "ENG-1",
  status: "working",
  terminal: false,
  ts: 0,
  startTs: 0,
  flaggedManually: false,
  acknowledged: false,
  ...over,
});

test("rowsToTable header has DUR at index 1 and FLAG last", () => {
  assert.deepEqual(rowsToTable([])[0], [
    "TIME", "DUR", "STATUS", "TICKET", "PR", "TITLE", "FLAG",
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
  const [, flagged] = rowsToTable(
    [row({ flaggedManually: true })],
    0,
  );
  assert.equal(flagged[6], "{red-fg}⚑{/red-fg}");
  const [, plain] = rowsToTable([row({})], 0);
  assert.equal(plain[6], "");
});

test("fmtDuration formats seconds, minutes, and hours", () => {
  assert.equal(fmtDuration(45_000), "45s");
  assert.equal(fmtDuration(18 * 60_000), "18m");
  assert.equal(fmtDuration((6 * 60 + 40) * 60_000), "6h 40m");
  assert.equal(fmtDuration(6 * 60 * 60_000), "6h");
});
