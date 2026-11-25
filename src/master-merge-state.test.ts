import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { tempDir } from "./test-temp.ts";
import {
  loadMasterMergeState,
  masterMergeStatePath,
  parseMasterMergeState,
  saveMasterMergeState,
} from "./master-merge-state.ts";

function withTempEventsLog<T>(fn: (dir: string) => T): T {
  const prevEnv = process.env.EVENTS_LOG;
  try {
    const dir = tempDir("yimbot-master-merge-");
    process.env.EVENTS_LOG = join(dir, "events.jsonl");
    return fn(dir);
  } finally {
    if (prevEnv === undefined) delete process.env.EVENTS_LOG;
    else process.env.EVENTS_LOG = prevEnv;
  }
}

test("parseMasterMergeState returns {} for empty, junk and arrays", () => {
  assert.deepEqual(parseMasterMergeState(""), {});
  assert.deepEqual(parseMasterMergeState("nope"), {});
  assert.deepEqual(parseMasterMergeState("[]"), {});
});

test("a valid entry parses and a malformed one is dropped", () => {
  const raw = JSON.stringify({
    "12": { sha: "abc", clean: true, commented: false, attempts: 2 },
    "13": { clean: true, commented: false, attempts: 1 },
    "14": { sha: "d", clean: "yes", commented: false, attempts: 1 },
    "15": { sha: "e", clean: true, commented: false, attempts: "1" },
  });
  assert.deepEqual(parseMasterMergeState(raw), {
    "12": { sha: "abc", clean: true, commented: false, attempts: 2 },
  });
});

test("save then load round-trips and sits next to the events log", () => {
  withTempEventsLog((dir) => {
    assert.equal(dirname(masterMergeStatePath()), dir);
    assert.equal(masterMergeStatePath(), join(dir, "master-merge.json"));
    const state = { "7": { sha: "s", clean: false, commented: true, attempts: 3 } };
    saveMasterMergeState(state);
    assert.deepEqual(loadMasterMergeState(), state);
  });
});

test("load returns {} when the file is missing", () => {
  withTempEventsLog(() => {
    assert.deepEqual(loadMasterMergeState(), {});
  });
});
