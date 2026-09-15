import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  freshQaState,
  loadQaState,
  parseQaState,
  prKey,
  qaStateFilePath,
  saveQaState,
  serializeQaState,
  type QaUnit,
} from "./qa-state.ts";
import { tempDir } from "./test-temp.ts";

function withTempEventsLog<T>(fn: (dir: string) => T): T {
  const prev = process.env.EVENTS_LOG;
  try {
    const dir = tempDir("yimbot-qa-state-");
    process.env.EVENTS_LOG = join(dir, "events.jsonl");
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.EVENTS_LOG;
    else process.env.EVENTS_LOG = prev;
  }
}

const unit: QaUnit = {
  identifier: "ENG-90",
  id: "uuid-90",
  repo: "acme/app",
  phase: "awaiting-deploy",
  lastPr: 12,
  prs: ["acme/app#12", "#7"],
  mergeSha: "abc",
  startedAt: 1000,
};

test("prKey qualifies extra-repo PR numbers and leaves primary ones bare", () => {
  assert.equal(prKey({ number: 12, repo: "acme/app" }), "acme/app#12");
  assert.equal(prKey({ number: 7 }), "#7");
});

test("qaStateFilePath sits next to the events log", () => {
  withTempEventsLog((dir) => {
    assert.equal(dirname(qaStateFilePath()), dir);
    assert.equal(qaStateFilePath(), join(dir, "qa-state.json"));
  });
});

test("serialize/parse round-trips units, processed PRs and the seeded flag", () => {
  const state = freshQaState();
  state.units.set("ENG-90", unit);
  state.processedPRs.add("acme/app#12");
  state.seeded = true;
  const back = parseQaState(serializeQaState(state));
  assert.deepEqual(back.units.get("ENG-90"), unit);
  assert.deepEqual([...back.processedPRs], ["acme/app#12"]);
  assert.equal(back.seeded, true);
});

test("a fresh state is unseeded and a missing or non-boolean seeded reads as false", () => {
  assert.equal(freshQaState().seeded, false);
  assert.equal(parseQaState('{"units":{},"processedPRs":[]}').seeded, false);
  assert.equal(parseQaState('{"seeded":"yes"}').seeded, false);
  assert.equal(parseQaState('{"seeded":true}').seeded, true);
});

test("parseQaState tolerates junk", () => {
  assert.deepEqual(parseQaState("nope"), freshQaState());
  assert.deepEqual(parseQaState("[1]"), freshQaState());
  assert.deepEqual(parseQaState('{"units":{"X":{"phase":"nope"}},"processedPRs":[3]}'), freshQaState());
});

test("save then load persists to disk; load with no file is fresh", () => {
  withTempEventsLog(() => {
    assert.deepEqual(loadQaState(), freshQaState());
    const state = freshQaState();
    state.units.set("ENG-90", unit);
    saveQaState(state);
    assert.ok(existsSync(qaStateFilePath()));
    assert.deepEqual(loadQaState().units.get("ENG-90"), unit);
  });
});
