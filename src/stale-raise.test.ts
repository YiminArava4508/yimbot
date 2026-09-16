import assert from "node:assert/strict";
import { test } from "node:test";
import type { YimbotEvent } from "./events.ts";
import { clearDeadRaises, type StaleRaiseDeps } from "./stale-raise.ts";

function raise(key: string, ts: number, reason: string, pane?: string): YimbotEvent {
  const kind = reason === "input" ? "needs_input" : "flagged";
  return { ts, kind, key, label: key, reason, ...(pane ? { pane } : {}) };
}

function deps(events: YimbotEvent[], live: string[] | null) {
  const cleared: { key: string; label: string; reason: string }[] = [];
  const logs: string[] = [];
  const d: StaleRaiseDeps = {
    events: () => events,
    livePanes: () => (live === null ? null : new Set(live)),
    clear: (key, label, reason) => void cleared.push({ key, label, reason }),
    log: (m) => void logs.push(m),
  };
  return { deps: d, cleared, logs };
}

test("clearDeadRaises clears a pending reason whose raising pane is gone", () => {
  const { deps: d, cleared, logs } = deps([raise("ENG-1", 100, "input", "%42")], ["%1"]);
  clearDeadRaises(d);
  assert.deepEqual(cleared, [{ key: "ENG-1", label: "ENG-1", reason: "input" }]);
  assert.match(logs[0] ?? "", /ENG-1.*input.*%42/);
});

test("clearDeadRaises leaves a reason alone while its pane exists", () => {
  const { deps: d, cleared } = deps([raise("ENG-1", 100, "input", "%42")], ["%42"]);
  clearDeadRaises(d);
  assert.deepEqual(cleared, []);
});

test("clearDeadRaises skips reasons raised without a pane", () => {
  const { deps: d, cleared } = deps([raise("ENG-1", 100, "input"), raise("ENG-1", 110, "human-comment")], []);
  clearDeadRaises(d);
  assert.deepEqual(cleared, []);
});

test("clearDeadRaises clears only the dead pane's reason, not the key's other reasons", () => {
  const { deps: d, cleared } = deps(
    [raise("ENG-1", 100, "decision", "%42"), raise("ENG-1", 110, "human-comment")],
    [],
  );
  clearDeadRaises(d);
  assert.deepEqual(cleared, [{ key: "ENG-1", label: "ENG-1", reason: "decision" }]);
});

test("clearDeadRaises keeps a reason while any of its raising panes is still alive", () => {
  const { deps: d, cleared } = deps([raise("ENG-1", 100, "input", "%6"), raise("ENG-1", 110, "input", "%50")], ["%6"]);
  clearDeadRaises(d);
  assert.deepEqual(cleared, []);
});

test("clearDeadRaises does nothing for a reason already cleared", () => {
  const events: YimbotEvent[] = [
    raise("ENG-1", 100, "input", "%42"),
    { ts: 200, kind: "input_received", key: "ENG-1", label: "ENG-1" },
  ];
  const { deps: d, cleared } = deps(events, []);
  clearDeadRaises(d);
  assert.deepEqual(cleared, []);
});

test("clearDeadRaises does nothing while the tmux server is unreachable", () => {
  const { deps: d, cleared } = deps([raise("ENG-1", 100, "input", "%42")], null);
  clearDeadRaises(d);
  assert.deepEqual(cleared, []);
});
