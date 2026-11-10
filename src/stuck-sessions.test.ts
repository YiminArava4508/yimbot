import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardRow, YimbotEvent } from "./events.ts";
import { MAX_RESUME_ATTEMPTS, detectStuckSessions, freshStuckState, type StuckDeps } from "./stuck-sessions.ts";

const MIN = 60_000;
const NOW = 100 * MIN;

const row = (over: Partial<BoardRow> = {}): BoardRow => ({
  key: "ENG-1",
  label: "ENG-1",
  status: "working",
  terminal: false,
  section: "tasks",
  ts: 0,
  startTs: 0,
  flagged: false,
  flagReasons: [],
  ...over,
});

const paneEvent = (pane: string, key = "ENG-1"): YimbotEvent => ({ ts: 1, kind: "needs_input", key, label: key, pane });

type Setup = {
  rows?: BoardRow[];
  events?: YimbotEvent[];
  panes?: Map<string, { cmd: string; activityMs: number }> | null;
  hasSession?: boolean;
};

function run(setup: Setup, state = freshStuckState()) {
  const emitted: { kind: string; key: string; reason?: string }[] = [];
  const resumed: string[] = [];
  const deps: StuckDeps = {
    events: () => setup.events ?? [],
    rows: () => setup.rows ?? [row()],
    panes: () => (setup.panes === undefined ? new Map() : setup.panes),
    hasSessionFor: () => setup.hasSession ?? false,
    now: () => NOW,
    idleMs: 30 * MIN,
    emit: (e) => emitted.push(e),
    resume: (pane) => resumed.push(pane),
    log: () => {},
  };
  detectStuckSessions(state, deps);
  return { emitted, resumed, state };
}

const pane = (cmd: string, ageMin = 0) => new Map([["%1", { cmd, activityMs: NOW - ageMin * MIN }]]);

test("dead pane and no tmux session emits session_stuck 'session ended'", () => {
  const { emitted } = run({ events: [paneEvent("%1")], panes: new Map() });
  assert.deepEqual(emitted.map((e) => [e.kind, e.reason]), [["session_stuck", "session ended"]]);
});

test("live pane with a shell foreground emits 'claude exited' and resumes the pane", () => {
  const { emitted, resumed } = run({ events: [paneEvent("%1")], panes: pane("zsh") });
  assert.deepEqual(emitted.map((e) => [e.kind, e.reason]), [["session_stuck", "claude exited"]]);
  assert.deepEqual(resumed, ["%1"]);
});

test("live claude pane silent past idleMs emits 'no activity 45m' and does not resume", () => {
  const { emitted, resumed } = run({ events: [paneEvent("%1")], panes: pane("claude", 45) });
  assert.deepEqual(emitted.map((e) => [e.kind, e.reason]), [["session_stuck", "no activity 45m"]]);
  assert.deepEqual(resumed, []);
});

test("live claude pane active within idleMs emits nothing", () => {
  const { emitted } = run({ events: [paneEvent("%1")], panes: pane("claude", 5) });
  assert.deepEqual(emitted, []);
});

test("a pane running something that is neither claude nor a shell is left alone", () => {
  const { emitted, resumed } = run({ events: [paneEvent("%1")], panes: pane("vim", 90) });
  assert.deepEqual(emitted, []);
  assert.deepEqual(resumed, []);
});

test("no known pane and a live session emits nothing", () => {
  assert.deepEqual(run({ events: [], hasSession: true }).emitted, []);
});

test("no known pane and no session emits 'session ended'", () => {
  const { emitted } = run({ events: [], hasSession: false });
  assert.deepEqual(emitted.map((e) => e.reason), ["session ended"]);
});

test("a terminal row emits nothing", () => {
  assert.deepEqual(run({ rows: [row({ status: "merged", terminal: true })], events: [] }).emitted, []);
});

test("a row that is not in a working status emits nothing", () => {
  assert.deepEqual(run({ rows: [row({ status: "draft pr" })], events: [] }).emitted, []);
});

test("an already stuck row does not re-emit the same reason", () => {
  const stuck = row({ status: "stuck", stuckReason: "session ended" });
  assert.deepEqual(run({ rows: [stuck], events: [paneEvent("%1")], panes: new Map() }).emitted, []);
});

test("an idle reason with a changed minute count does not re-emit", () => {
  const stuck = row({ status: "stuck", stuckReason: "no activity 31m" });
  assert.deepEqual(run({ rows: [stuck], events: [paneEvent("%1")], panes: pane("claude", 45) }).emitted, []);
});

test("a stuck row whose pane is healthy again emits session_resumed", () => {
  const stuck = row({ status: "stuck", stuckReason: "claude exited" });
  const { emitted } = run({ rows: [stuck], events: [paneEvent("%1")], panes: pane("claude", 1) });
  assert.deepEqual(emitted.map((e) => e.kind), ["session_resumed"]);
});

test("unreachable tmux emits nothing and resumes nothing", () => {
  const { emitted, resumed } = run({ events: [paneEvent("%1")], panes: null });
  assert.deepEqual(emitted, []);
  assert.deepEqual(resumed, []);
});

test("resume stops after MAX_RESUME_ATTEMPTS and the row stays stuck", () => {
  const state = freshStuckState();
  const stuck = row({ status: "stuck", stuckReason: "claude exited" });
  let total = 0;
  for (let i = 0; i < MAX_RESUME_ATTEMPTS + 2; i++) {
    total += run({ rows: [stuck], events: [paneEvent("%1")], panes: pane("bash") }, state).resumed.length;
  }
  assert.equal(total, MAX_RESUME_ATTEMPTS);
});

test("a recovered session gets a fresh resume budget", () => {
  const state = freshStuckState();
  const stuck = row({ status: "stuck", stuckReason: "claude exited" });
  run({ rows: [stuck], events: [paneEvent("%1")], panes: pane("bash") }, state);
  run({ rows: [stuck], events: [paneEvent("%1")], panes: pane("claude", 1) }, state);
  assert.equal(state.resumeAttempts.get("ENG-1") ?? 0, 0);
});
