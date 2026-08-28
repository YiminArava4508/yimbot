import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReviewState, readViewed, reviewStateFilePath, stateKey, withViewed, writeViewed } from "./review-state.ts";

test("stateKey combines PR number and head SHA", () => {
  assert.equal(stateKey(7, "abc123"), "7:abc123");
});

test("parseReviewState tolerates junk and wrong shapes", () => {
  assert.deepEqual(parseReviewState("not json"), {});
  assert.deepEqual(parseReviewState('{"7:abc":["a.ts",5],"bad":"x"}'), { "7:abc": ["a.ts"] });
});

test("withViewed replaces older entries for the same PR and keeps other PRs", () => {
  const prev = { "7:oldsha": ["a.ts"], "9:zzz": ["b.ts"] };
  const next = withViewed(prev, 7, "newsha", ["c.ts"]);
  assert.deepEqual(next, { "9:zzz": ["b.ts"], "7:newsha": ["c.ts"] });
});

test("withViewed caps the file at 50 entries, dropping the oldest", () => {
  const prev: Record<string, string[]> = {};
  for (let i = 0; i < 50; i++) prev[`${i}:sha`] = [];
  const next = withViewed(prev, 999, "sha", ["x.ts"]);
  assert.equal(Object.keys(next).length, 50);
  assert.ok(!("0:sha" in next));
  assert.deepEqual(next["999:sha"], ["x.ts"]);
});

test("readViewed and writeViewed round-trip through the file next to the events log", () => {
  const prevEnv = process.env.EVENTS_LOG;
  try {
    const dir = mkdtempSync(join(tmpdir(), "yimbot-review-"));
    process.env.EVENTS_LOG = join(dir, "events.jsonl");
    assert.deepEqual(readViewed(7, "abc"), new Set());
    writeViewed(7, "abc", new Set(["a.ts", "b.ts"]));
    assert.deepEqual(readViewed(7, "abc"), new Set(["a.ts", "b.ts"]));
    assert.deepEqual(readViewed(7, "othersha"), new Set());
    const onDisk = JSON.parse(readFileSync(reviewStateFilePath(), "utf8"));
    assert.deepEqual(onDisk[stateKey(7, "abc")].sort(), ["a.ts", "b.ts"]);
  } finally {
    if (prevEnv === undefined) delete process.env.EVENTS_LOG;
    else process.env.EVENTS_LOG = prevEnv;
  }
});

test("readViewed survives a corrupt state file", () => {
  const prevEnv = process.env.EVENTS_LOG;
  try {
    const dir = mkdtempSync(join(tmpdir(), "yimbot-review-"));
    process.env.EVENTS_LOG = join(dir, "events.jsonl");
    writeFileSync(reviewStateFilePath(), "{{{");
    assert.deepEqual(readViewed(7, "abc"), new Set());
  } finally {
    if (prevEnv === undefined) delete process.env.EVENTS_LOG;
    else process.env.EVENTS_LOG = prevEnv;
  }
});
