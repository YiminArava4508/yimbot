import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSyncStatus } from "./worktree-sync.ts";

test("parseSyncStatus is clean for empty porcelain and zero ahead", () => {
  assert.deepEqual(parseSyncStatus("", "0\n", "abc\n"), { dirty: false, unpushed: 0, head: "abc" });
});

test("parseSyncStatus flags any porcelain line as dirty and reads the ahead count", () => {
  assert.deepEqual(parseSyncStatus(" M src/a.ts\n", "2\n", "abc"), { dirty: true, unpushed: 2, head: "abc" });
});

test("parseSyncStatus returns null when the ahead count is not a number", () => {
  assert.equal(parseSyncStatus("", "fatal: bad", "abc"), null);
});
