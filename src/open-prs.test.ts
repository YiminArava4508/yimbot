import { test } from "node:test";
import assert from "node:assert/strict";
import { openPrKeys, setOpenPrKeys } from "./open-prs.ts";

test("openPrKeys: starts empty", () => {
  setOpenPrKeys(new Set());
  assert.deepEqual([...openPrKeys()], []);
});

test("openPrKeys: returns what the last successful list set", () => {
  setOpenPrKeys(new Set(["ENG-1", "ENG-2"]));
  assert.deepEqual([...openPrKeys()].sort(), ["ENG-1", "ENG-2"]);
  setOpenPrKeys(new Set(["ENG-3"]));
  assert.deepEqual([...openPrKeys()], ["ENG-3"]);
});

test("openPrKeys: the cache is a snapshot, not the caller's set", () => {
  const live = new Set(["ENG-1"]);
  setOpenPrKeys(live);
  live.add("ENG-2");
  assert.deepEqual([...openPrKeys()], ["ENG-1"], "a later mutation must not reach the cache");
  const read = openPrKeys();
  read.add("ENG-9");
  assert.deepEqual([...openPrKeys()], ["ENG-1"], "a mutated read must not reach the cache");
});
