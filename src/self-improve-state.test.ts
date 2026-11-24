import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./test-temp.ts";
import { SELF_IMPROVE_JOBS, type SelfImproveJob } from "./self-improve-jobs.ts";
import {
  isDue,
  loadSelfImproveState,
  parseSelfImproveState,
  periodKey,
  saveSelfImproveState,
  selfImproveStatePath,
} from "./self-improve-state.ts";

const daily: SelfImproveJob = { id: "a", skill: "a", settingKey: "K", cadence: "daily", hour: 0, label: "a" };
const weekly: SelfImproveJob = { ...daily, id: "w", cadence: "weekly" };

test("registry ships the dead-code-scan job", () => {
  assert.deepEqual(SELF_IMPROVE_JOBS, [
    {
      id: "dead-code-scan",
      skill: "dead-code-scan",
      settingKey: "AUTO_SELF_IMPROVE_DEAD_CODE_SCAN",
      cadence: "daily",
      hour: 0,
      label: "dead code scan",
    },
  ]);
});

test("periodKey daily is the local date", () => {
  assert.equal(periodKey(daily, new Date(2026, 10, 24, 0, 5)), "2026-11-24");
  assert.equal(periodKey(daily, new Date(2026, 10, 24, 23, 59)), "2026-11-24");
});

test("periodKey weekly is the local ISO week, with Sunday in the week it ends", () => {
  assert.equal(periodKey(weekly, new Date(2026, 10, 23, 9)), "2026-W48");
  assert.equal(periodKey(weekly, new Date(2026, 10, 29, 9)), "2026-W48");
  assert.equal(periodKey(weekly, new Date(2026, 10, 30, 9)), "2026-W49");
});

test("periodKey weekly crosses the year boundary by ISO rules", () => {
  assert.equal(periodKey(weekly, new Date(2027, 0, 1, 9)), "2026-W53");
  assert.equal(periodKey(weekly, new Date(2027, 0, 4, 9)), "2027-W01");
});

test("isDue is false before the job hour and true at it", () => {
  const job = { ...daily, hour: 2 };
  assert.equal(isDue(job, undefined, new Date(2026, 10, 24, 1, 59)), false);
  assert.equal(isDue(job, undefined, new Date(2026, 10, 24, 2, 0)), true);
});

test("isDue is false when it already ran this period and true for an earlier one", () => {
  const now = new Date(2026, 10, 24, 3);
  assert.equal(isDue(daily, "2026-11-24", now), false);
  assert.equal(isDue(daily, "2026-11-23", now), true);
});

test("isDue lets hourOverride win over the job hour", () => {
  const job = { ...daily, hour: 5 };
  const now = new Date(2026, 10, 24, 1);
  assert.equal(isDue(job, undefined, now), false);
  assert.equal(isDue(job, undefined, now, 0), true);
});

test("parseSelfImproveState returns {} for empty, corrupt and array input", () => {
  assert.deepEqual(parseSelfImproveState(""), {});
  assert.deepEqual(parseSelfImproveState("nope"), {});
  assert.deepEqual(parseSelfImproveState("[]"), {});
});

test("parseSelfImproveState drops non-string values", () => {
  assert.deepEqual(parseSelfImproveState(JSON.stringify({ a: "2026-11-24", b: 3, c: null })), { a: "2026-11-24" });
});

test("state round-trips through the file next to the events log", () => {
  const prev = process.env.EVENTS_LOG;
  try {
    const dir = tempDir("yimbot-self-improve-");
    process.env.EVENTS_LOG = join(dir, "events.jsonl");
    assert.equal(selfImproveStatePath(), join(dir, "self-improve.json"));
    assert.deepEqual(loadSelfImproveState(), {});
    saveSelfImproveState({ "dead-code-scan": "2026-11-24" });
    assert.deepEqual(loadSelfImproveState(), { "dead-code-scan": "2026-11-24" });
  } finally {
    if (prev === undefined) delete process.env.EVENTS_LOG;
    else process.env.EVENTS_LOG = prev;
  }
});
