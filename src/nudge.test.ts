import assert from "node:assert/strict";
import { test } from "node:test";
import type { YimbotEvent } from "./events.ts";
import { freshNudgeState, NUDGE_PROMPT, nudgeOnce, type NudgeDeps } from "./nudge.ts";

function needsInput(key: string, ts: number, pane?: string): YimbotEvent {
  return { ts, kind: "needs_input", key, label: key, ...(pane ? { pane } : {}) };
}

function deps(events: YimbotEvent[], overrides: Partial<NudgeDeps> = {}): {
  deps: NudgeDeps;
  sent: { pane: string; prompt: string }[];
  flagged: { key: string; label: string; reason: string }[];
  logs: string[];
} {
  const sent: { pane: string; prompt: string }[] = [];
  const flagged: { key: string; label: string; reason: string }[] = [];
  const logs: string[] = [];
  const d: NudgeDeps = {
    mode: () => "autonomous",
    events: () => events,
    send: (pane, prompt) => {
      sent.push({ pane, prompt });
      return true;
    },
    raiseFlag: (key, label, reason) => void flagged.push({ key, label, reason }),
    log: (m) => void logs.push(m),
    maxNudges: 3,
    ...overrides,
  };
  return { deps: d, sent, flagged, logs };
}

test("nudgeOnce sends the staff-engineer prompt to the stuck event's pane", () => {
  const { deps: d, sent, flagged } = deps([needsInput("ENG-1", 100, "%42")]);
  nudgeOnce(freshNudgeState(), d);
  assert.deepEqual(sent, [{ pane: "%42", prompt: NUDGE_PROMPT }]);
  assert.equal(flagged.length, 0);
});

test("nudgeOnce does not re-nudge the same raise on a later tick", () => {
  const { deps: d, sent } = deps([needsInput("ENG-1", 100, "%42")]);
  const state = freshNudgeState();
  nudgeOnce(state, d);
  nudgeOnce(state, d);
  assert.equal(sent.length, 1);
});

test("nudgeOnce nudges again on a fresh raise after the previous one cleared", () => {
  const events: YimbotEvent[] = [needsInput("ENG-1", 100, "%42")];
  const { deps: d, sent } = deps(events);
  const state = freshNudgeState();
  nudgeOnce(state, d);
  events.push({ ts: 150, kind: "input_received", key: "ENG-1", label: "ENG-1" });
  events.push(needsInput("ENG-1", 200, "%42"));
  nudgeOnce(state, d);
  assert.equal(sent.length, 2);
});

test("nudgeOnce flags the key stuck instead of nudging past the cap", () => {
  const events: YimbotEvent[] = [needsInput("ENG-1", 100, "%42")];
  const { deps: d, sent, flagged } = deps(events, { maxNudges: 2 });
  const state = freshNudgeState();
  nudgeOnce(state, d);
  events.push({ ts: 150, kind: "input_received", key: "ENG-1", label: "ENG-1" }, needsInput("ENG-1", 200, "%42"));
  nudgeOnce(state, d);
  events.push({ ts: 250, kind: "input_received", key: "ENG-1", label: "ENG-1" }, needsInput("ENG-1", 300, "%42"));
  nudgeOnce(state, d);
  assert.equal(sent.length, 2);
  assert.deepEqual(flagged, [{ key: "ENG-1", label: "ENG-1", reason: "stuck" }]);
});

test("nudgeOnce does nothing in supervised mode", () => {
  const { deps: d, sent, flagged } = deps([needsInput("ENG-1", 100, "%42")], { mode: () => "supervised" });
  nudgeOnce(freshNudgeState(), d);
  assert.equal(sent.length + flagged.length, 0);
});

test("nudgeOnce skips a raise that was already answered", () => {
  const { deps: d, sent } = deps([
    needsInput("ENG-1", 100, "%42"),
    { ts: 150, kind: "input_received", key: "ENG-1", label: "ENG-1" },
  ]);
  nudgeOnce(freshNudgeState(), d);
  assert.equal(sent.length, 0);
});

test("nudgeOnce flags stuck when the event carries no pane to target", () => {
  const { deps: d, sent, flagged } = deps([needsInput("ENG-1", 100)]);
  nudgeOnce(freshNudgeState(), d);
  assert.equal(sent.length, 0);
  assert.deepEqual(flagged, [{ key: "ENG-1", label: "ENG-1", reason: "stuck" }]);
});

test("nudgeOnce flags stuck when the pane no longer runs Claude", () => {
  const { deps: d, flagged } = deps([needsInput("ENG-1", 100, "%42")], { send: () => false });
  const state = freshNudgeState();
  nudgeOnce(state, d);
  nudgeOnce(state, d); // same raise: no second flag attempt, no retry loop
  assert.deepEqual(flagged, [{ key: "ENG-1", label: "ENG-1", reason: "stuck" }]);
  assert.equal(state.counts.get("ENG-1"), undefined);
});

test("nudgeOnce retries next tick when the tmux send fails", () => {
  const events = [needsInput("ENG-1", 100, "%42")];
  let fail = true;
  const sent: { pane: string; prompt: string }[] = [];
  const { deps: d, logs } = deps(events, {
    send: (pane, prompt) => {
      if (fail) throw new Error("no such pane");
      sent.push({ pane, prompt });
      return true;
    },
  });
  const state = freshNudgeState();
  nudgeOnce(state, d);
  assert.equal(sent.length, 0);
  assert.ok(logs.some((l) => /no such pane/.test(l)));
  fail = false;
  nudgeOnce(state, d);
  assert.equal(sent.length, 1);
});

test("nudgeOnce handles independent keys separately", () => {
  const { deps: d, sent } = deps([needsInput("ENG-1", 100, "%1"), needsInput("ENG-2", 110, "%2")]);
  nudgeOnce(freshNudgeState(), d);
  assert.deepEqual(sent.map((s) => s.pane), ["%1", "%2"]);
});
