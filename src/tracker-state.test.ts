import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  isLinearTracker,
  loadTrackerState,
  parseTrackerState,
  saveTrackerState,
  serializeTrackerState,
  trackerStateFilePath,
} from "./tracker-state.ts";
import { tempDir } from "./test-temp.ts";

function withTempEventsLog<T>(fn: (dir: string) => T): T {
  const prev = process.env.EVENTS_LOG;
  try {
    const dir = tempDir("yimbot-tracker-state-");
    process.env.EVENTS_LOG = join(dir, "events.jsonl");
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.EVENTS_LOG;
    else process.env.EVENTS_LOG = prev;
  }
}

test("isLinearTracker: children and a zero estimate", () => {
  assert.equal(isLinearTracker({ estimate: 0, hasChildren: true }), true);
});

test("isLinearTracker: children with a nonzero estimate is dev work", () => {
  assert.equal(isLinearTracker({ estimate: 3, hasChildren: true }), false);
});

test("isLinearTracker: a zero-point leaf is not a tracker", () => {
  assert.equal(isLinearTracker({ estimate: 0, hasChildren: false }), false);
});

test("isLinearTracker: an issue without the shape fields is dev work", () => {
  assert.equal(isLinearTracker({}), false);
  assert.equal(isLinearTracker({ estimate: null, hasChildren: true }), false);
});

test("tracker state round-trips through serialize and parse", () => {
  const ids = new Set(["ENG-1325", "ENG-1925"]);
  assert.deepEqual(parseTrackerState(serializeTrackerState(ids)), ids);
});

test("parseTrackerState tolerates garbage and drops non-strings", () => {
  assert.deepEqual(parseTrackerState("not json"), new Set());
  assert.deepEqual(parseTrackerState('{"trackers": ["ENG-1", 7, null]}'), new Set(["ENG-1"]));
  assert.deepEqual(parseTrackerState("[]"), new Set());
});

test("tracker state lives next to the events log", () => {
  withTempEventsLog((dir) => {
    assert.equal(dirname(trackerStateFilePath()), dir);
    assert.ok(trackerStateFilePath().endsWith("tracker-state.json"));
  });
});

test("load returns empty when no file exists; save then load round-trips", () => {
  withTempEventsLog(() => {
    assert.deepEqual(loadTrackerState(), new Set());
    saveTrackerState(new Set(["ENG-1325"]));
    assert.ok(existsSync(trackerStateFilePath()));
    assert.deepEqual(loadTrackerState(), new Set(["ENG-1325"]));
  });
});
