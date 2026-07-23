import assert from "node:assert/strict";
import { test } from "node:test";
import { gitSyncArgs } from "./codebase-sync.ts";

test("on the main branch: fast-forward pull from origin", () => {
  assert.deepEqual(gitSyncArgs("main", "main"), [
    "pull",
    "--ff-only",
    "origin",
    "main",
  ]);
});

test("on a feature branch: fetch main into main without switching", () => {
  assert.deepEqual(gitSyncArgs("eng-42-thing", "main"), [
    "fetch",
    "origin",
    "main:main",
  ]);
});

test("detached HEAD is treated as not-on-main", () => {
  assert.deepEqual(gitSyncArgs("HEAD", "main"), [
    "fetch",
    "origin",
    "main:main",
  ]);
});
