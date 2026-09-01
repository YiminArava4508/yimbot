import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseReviewState,
  readGroups,
  readViewed,
  reviewStateFilePath,
  stateKey,
  withEntry,
  writeGroups,
  writeViewed,
} from "./review-state.ts";

const GROUPS = { summary: "s", groups: [{ title: "core", context: "c", files: ["a.ts"] }] };

test("stateKey combines PR number and head SHA", () => {
  assert.equal(stateKey(7, "abc123"), "7:abc123");
});

test("parseReviewState tolerates junk and wrong shapes", () => {
  assert.deepEqual(parseReviewState("not json"), {});
  assert.deepEqual(parseReviewState('{"7:abc":{"viewed":["a.ts",5]},"bad":"x"}'), { "7:abc": { viewed: ["a.ts"] } });
});

test("parseReviewState reads a legacy bare-array entry as viewed-only", () => {
  assert.deepEqual(parseReviewState('{"7:abc":["a.ts","b.ts"]}'), { "7:abc": { viewed: ["a.ts", "b.ts"] } });
});

test("parseReviewState keeps a cached groups payload verbatim", () => {
  const raw = JSON.stringify({ "7:abc": { viewed: [], groups: GROUPS } });
  assert.deepEqual(parseReviewState(raw)["7:abc"].groups, GROUPS);
});

test("withEntry merges the patch onto the same key, keeping the untouched field", () => {
  const prev = { "7:sha": { viewed: ["a.ts"] } };
  const withG = withEntry(prev, 7, "sha", { groups: GROUPS });
  assert.deepEqual(withG["7:sha"], { viewed: ["a.ts"], groups: GROUPS });
  const withV = withEntry(withG, 7, "sha", { viewed: ["a.ts", "b.ts"] });
  assert.deepEqual(withV["7:sha"], { viewed: ["a.ts", "b.ts"], groups: GROUPS });
});

test("withEntry replaces older entries for the same PR and keeps other PRs", () => {
  const prev = { "7:oldsha": { viewed: ["a.ts"] }, "9:zzz": { viewed: ["b.ts"] } };
  const next = withEntry(prev, 7, "newsha", { viewed: ["c.ts"] });
  assert.deepEqual(next, { "9:zzz": { viewed: ["b.ts"] }, "7:newsha": { viewed: ["c.ts"] } });
});

test("withEntry caps the file at 50 entries, dropping the oldest", () => {
  const prev: Record<string, { viewed: string[] }> = {};
  for (let i = 0; i < 50; i++) prev[`${i}:sha`] = { viewed: [] };
  const next = withEntry(prev, 999, "sha", { viewed: ["x.ts"] });
  assert.equal(Object.keys(next).length, 50);
  assert.ok(!("0:sha" in next));
  assert.deepEqual(next["999:sha"].viewed, ["x.ts"]);
});

function inTempStateDir(fn: () => void): void {
  const prevEnv = process.env.EVENTS_LOG;
  try {
    const dir = mkdtempSync(join(tmpdir(), "yimbot-review-"));
    process.env.EVENTS_LOG = join(dir, "events.jsonl");
    fn();
  } finally {
    if (prevEnv === undefined) delete process.env.EVENTS_LOG;
    else process.env.EVENTS_LOG = prevEnv;
  }
}

test("readViewed and writeViewed round-trip through the file next to the events log", () => {
  inTempStateDir(() => {
    assert.deepEqual(readViewed(7, "abc"), new Set());
    writeViewed(7, "abc", new Set(["a.ts", "b.ts"]));
    assert.deepEqual(readViewed(7, "abc"), new Set(["a.ts", "b.ts"]));
    assert.deepEqual(readViewed(7, "othersha"), new Set());
    const onDisk = JSON.parse(readFileSync(reviewStateFilePath(), "utf8"));
    assert.deepEqual(onDisk[stateKey(7, "abc")].viewed.sort(), ["a.ts", "b.ts"]);
  });
});

test("readViewed reads a state file written by an older version", () => {
  inTempStateDir(() => {
    writeFileSync(reviewStateFilePath(), JSON.stringify({ "7:abc": ["a.ts"] }));
    assert.deepEqual(readViewed(7, "abc"), new Set(["a.ts"]));
  });
});

test("readGroups and writeGroups round-trip, and viewed marks survive alongside them", () => {
  inTempStateDir(() => {
    assert.equal(readGroups(7, "abc"), null);
    writeGroups(7, "abc", GROUPS);
    assert.deepEqual(readGroups(7, "abc"), GROUPS);
    writeViewed(7, "abc", new Set(["a.ts"]));
    assert.deepEqual(readGroups(7, "abc"), GROUPS);
    assert.deepEqual(readViewed(7, "abc"), new Set(["a.ts"]));
  });
});

test("readGroups misses on a different head SHA so a new push regroups", () => {
  inTempStateDir(() => {
    writeGroups(7, "abc", GROUPS);
    assert.equal(readGroups(7, "newsha"), null);
  });
});

test("readViewed and readGroups survive a corrupt state file", () => {
  inTempStateDir(() => {
    writeFileSync(reviewStateFilePath(), "{{{");
    assert.deepEqual(readViewed(7, "abc"), new Set());
    assert.equal(readGroups(7, "abc"), null);
  });
});

test("parseReviewState keeps a cached flow annotation beside the groups", () => {
  const st = parseReviewState(JSON.stringify({
    "7:abc": { viewed: ["a.ts"], groups: { summary: "s" }, flow: { flow: "f" } },
  }));
  assert.deepEqual(st["7:abc"].flow, { flow: "f" });
  assert.deepEqual(st["7:abc"].viewed, ["a.ts"]);
});

test("withEntry patching flow leaves viewed and groups alone", () => {
  const st = { "7:abc": { viewed: ["a.ts"], groups: { summary: "s" } } };
  const next = withEntry(st, 7, "abc", { flow: { flow: "f" } });
  assert.deepEqual(next["7:abc"].viewed, ["a.ts"]);
  assert.deepEqual(next["7:abc"].groups, { summary: "s" });
  assert.deepEqual(next["7:abc"].flow, { flow: "f" });
});

test("withEntry under a new head sha drops the old flow with the old entry", () => {
  const st = { "7:abc": { viewed: [], flow: { flow: "old" } } };
  const next = withEntry(st, 7, "def", { viewed: [] });
  assert.equal(next["7:abc"], undefined);
  assert.equal(next["7:def"].flow, undefined);
});
