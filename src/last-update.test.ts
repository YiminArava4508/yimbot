import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readLastUpdate, recordLastUpdate } from "./last-update.ts";

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "last-update-")), "last-update.json");

test("recordLastUpdate writes the update a self-update boot applied", () => {
  const path = tmpFile();
  recordLastUpdate(path, { YIMBOT_UPDATED_FROM: "aaaaaaa1" }, "bbbbbbb2", 5_000);
  assert.deepEqual(readLastUpdate(path), { at: 5_000, from: "aaaaaaa1", to: "bbbbbbb2" });
});

test("recordLastUpdate keeps only the latest update", () => {
  const path = tmpFile();
  recordLastUpdate(path, { YIMBOT_UPDATED_FROM: "a" }, "b", 1);
  recordLastUpdate(path, { YIMBOT_UPDATED_FROM: "b" }, "c", 2);
  assert.deepEqual(readLastUpdate(path), { at: 2, from: "b", to: "c" });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).to, "c");
});

test("recordLastUpdate ignores a plain boot, a no-op update and a rollback", () => {
  const path = tmpFile();
  recordLastUpdate(path, {}, "b", 1);
  recordLastUpdate(path, { YIMBOT_UPDATED_FROM: "b" }, "b", 1);
  recordLastUpdate(path, { YIMBOT_UPDATED_FROM: "a", YIMBOT_ROLLED_BACK: "c" }, "b", 1);
  assert.equal(readLastUpdate(path), null);
});

test("readLastUpdate returns null for a missing or malformed file", () => {
  const path = tmpFile();
  assert.equal(readLastUpdate(path), null);
  writeFileSync(path, "{not json");
  assert.equal(readLastUpdate(path), null);
  writeFileSync(path, JSON.stringify({ at: "yesterday", from: "a", to: "b" }));
  assert.equal(readLastUpdate(path), null);
});
