import assert from "node:assert/strict";
import { test } from "node:test";
import { fmtDuration, footerHint, returnKey, rowsToTable } from "./tui.ts";
import type { BoardRow } from "./events.ts";

const row = (over: Partial<BoardRow>): BoardRow => ({
  key: "ENG-1",
  label: "ENG-1",
  status: "working",
  terminal: false,
  ts: 0,
  startTs: 0,
  flagged: false,
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
  const [, flagged] = rowsToTable([row({ flagged: true })], 0);
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
  assert.match(hint, /q quit/);
  assert.match(hint, /prefix\+F12 returns here/);
});
