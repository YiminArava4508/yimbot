import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardRow, YimbotEvent } from "./events.ts";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./test-temp.ts";
import { IDLE_NUDGE_PROMPT, MAX_RESUME_ATTEMPTS, detectStuckSessions, transcriptLastWriteMs, isClaudeCommand, stuckIdleMs, freshStuckState, type StuckDeps } from "./stuck-sessions.ts";

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

const paneEvent = (pane: string, key = "ENG-1", kind: YimbotEvent["kind"] = "needs_input"): YimbotEvent => ({ ts: 1, kind, key, label: key, pane });

type Setup = {
  rows?: BoardRow[];
  events?: YimbotEvent[];
  panes?: Map<string, { cmd: string; activityMs: number; session: string }> | null;
  hasSession?: boolean;
  now?: number;
  canNudge?: boolean;
  nudgeDelivers?: boolean;
  writes?: Record<string, number>;
};

function run(setup: Setup, state = freshStuckState()) {
  const emitted: { kind: string; key: string; reason?: string }[] = [];
  const resumed: string[] = [];
  const nudged: { pane: string; prompt: string }[] = [];
  const deps: StuckDeps = {
    events: () => setup.events ?? [],
    rows: () => setup.rows ?? [row()],
    panes: () => (setup.panes === undefined ? new Map() : setup.panes),
    hasSessionFor: () => setup.hasSession ?? false,
    ownsSession: (session, key) => session.toLowerCase().startsWith(key.toLowerCase()),
    now: () => setup.now ?? NOW,
    idleMs: 30 * MIN,
    lastWriteMs: (t) => setup.writes?.[t] ?? null,
    emit: (e) => emitted.push(e),
    resume: (pane) => resumed.push(pane),
    canNudge: () => setup.canNudge ?? false,
    nudge: (pane, prompt) => {
      nudged.push({ pane, prompt });
      return setup.nudgeDelivers ?? true;
    },
    log: () => {},
  };
  detectStuckSessions(state, deps);
  return { emitted, resumed, nudged, state };
}

const info = (cmd: string, ageMin = 0, session = "eng-1-task") => ({ cmd, activityMs: NOW - ageMin * MIN, session });
const pane = (cmd: string, ageMin = 0, session = "eng-1-task") => new Map([["%1", info(cmd, ageMin, session)]]);

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

test("a spike awaiting approval is never flagged stuck, however long it sits quiet", () => {
  const { emitted } = run({ rows: [row({ status: "awaiting approval" })], events: [paneEvent("%1")], panes: pane("claude", 600) });
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

test("resume stops after MAX_RESUME_ATTEMPTS within the window and the row stays stuck", () => {
  const state = freshStuckState();
  const stuck = row({ status: "stuck", stuckReason: "claude exited" });
  let total = 0;
  for (let i = 0; i < MAX_RESUME_ATTEMPTS + 2; i++) {
    total += run({ rows: [stuck], events: [paneEvent("%1")], panes: pane("bash") }, state).resumed.length;
  }
  assert.equal(total, MAX_RESUME_ATTEMPTS);
});

test("a healthy pass in between does not refund the resume budget (crash loop)", () => {
  const state = freshStuckState();
  const stuck = row({ status: "stuck", stuckReason: "claude exited" });
  let total = 0;
  for (let i = 0; i < 6; i++) {
    total += run({ rows: [stuck], events: [paneEvent("%1")], panes: pane("bash") }, state).resumed.length;
    run({ rows: [stuck], events: [paneEvent("%1")], panes: pane("claude", 1) }, state);
  }
  assert.equal(total, MAX_RESUME_ATTEMPTS);
});

test("the resume budget refreshes once the window has passed", () => {
  const state = freshStuckState();
  const stuck = row({ status: "stuck", stuckReason: "claude exited" });
  for (let i = 0; i < MAX_RESUME_ATTEMPTS; i++) run({ rows: [stuck], events: [paneEvent("%1")], panes: pane("bash") }, state);
  const later = run({ rows: [stuck], events: [paneEvent("%1")], panes: pane("bash"), now: NOW + 2 * 60 * MIN }, state);
  assert.equal(later.resumed.length, 1);
});

test("a refining or qa row with no known pane is never judged", () => {
  for (const status of ["refining", "qa: in session"]) {
    assert.deepEqual(run({ rows: [row({ status })], events: [], hasSession: false }).emitted, [], status);
  }
});

test("a recycled pane id now in an unrelated session gets no keystrokes", () => {
  const { resumed } = run({ events: [paneEvent("%1")], panes: pane("zsh", 0, "main"), hasSession: true });
  assert.deepEqual(resumed, []);
});

test("a shell pane beside a live claude in the same session (fix window) is healthy", () => {
  const panes = new Map([["%1", info("zsh")], ["%2", info("claude", 1)]]);
  const { emitted, resumed } = run({ events: [paneEvent("%1")], panes });
  assert.deepEqual(emitted, []);
  assert.deepEqual(resumed, []);
});

test("only the newest known pane of a row is judged", () => {
  const events = [paneEvent("%1"), { ...paneEvent("%2"), ts: 2 }];
  const panes = new Map([["%2", info("claude", 1)]]);
  assert.deepEqual(run({ events, panes }).emitted, []);
});

test("a deliberate exit (session_ended) shows stuck but is not resumed", () => {
  const events = [paneEvent("%1"), { ...paneEvent("%1", "ENG-1", "session_ended"), ts: 2 }];
  const { emitted, resumed } = run({ events, panes: pane("zsh") });
  assert.deepEqual(emitted.map((e) => e.reason), ["claude exited"]);
  assert.deepEqual(resumed, []);
});

test("stuckIdleMs defaults to 30 minutes and ignores a bad value", () => {
  assert.equal(stuckIdleMs(undefined), 30 * MIN);
  assert.equal(stuckIdleMs("45"), 45 * MIN);
  for (const bad of ["abc", "0", "-5", ""]) assert.equal(stuckIdleMs(bad), 30 * MIN, bad);
});

test("isClaudeCommand accepts claude, node and a bare version", () => {
  for (const cmd of ["claude", "node", "2.1.327"]) assert.equal(isClaudeCommand(cmd), true, cmd);
});

test("isClaudeCommand rejects shells, editors, partial versions and empty", () => {
  for (const cmd of ["zsh", "bash", "vim", "2.1", ""]) assert.equal(isClaudeCommand(cmd), false, cmd);
});

test("a pane running a version-named binary counts as claude: idle fires, no resume", () => {
  const { emitted, resumed } = run({ events: [paneEvent("%1")], panes: pane("2.1.327", 45) });
  assert.deepEqual(emitted.map((e) => [e.kind, e.reason]), [["session_stuck", "no activity 45m"]]);
  assert.deepEqual(resumed, []);
});

test("an idle live claude is nudged in its own pane when nudging is allowed", () => {
  const { emitted, resumed, nudged } = run({ events: [paneEvent("%1")], panes: pane("claude", 45), canNudge: true });
  assert.deepEqual(emitted.map((e) => [e.kind, e.reason]), [["session_stuck", "no activity 45m"]]);
  assert.deepEqual(resumed, []);
  assert.deepEqual(nudged, [{ pane: "%1", prompt: IDLE_NUDGE_PROMPT }]);
});

test("an idle live claude is not nudged when nudging is disallowed (manual mode or low disk)", () => {
  const state = freshStuckState();
  const { nudged } = run({ events: [paneEvent("%1")], panes: pane("claude", 45), canNudge: false }, state);
  assert.deepEqual(nudged, []);
  // and no attempt was spent, so the full budget is there once nudging is allowed
  assert.equal(state.resumeAttempts.get("ENG-1"), undefined);
});

test("an active claude is never nudged", () => {
  const { nudged } = run({ events: [paneEvent("%1")], panes: pane("claude", 5), canNudge: true });
  assert.deepEqual(nudged, []);
});

test("idle nudges share the resume budget and stop after MAX_RESUME_ATTEMPTS", () => {
  const state = freshStuckState();
  let total = 0;
  for (let i = 0; i < MAX_RESUME_ATTEMPTS + 2; i++) {
    const rows = [row(i === 0 ? {} : { status: "stuck", stuckReason: "no activity 45m" })];
    total += run({ rows, events: [paneEvent("%1")], panes: pane("claude", 45), canNudge: true, now: NOW + i * MIN }, state).nudged.length;
  }
  assert.equal(total, MAX_RESUME_ATTEMPTS);
});

test("an undelivered nudge still spends an attempt", () => {
  const state = freshStuckState();
  run({ events: [paneEvent("%1")], panes: pane("claude", 45), canNudge: true, nudgeDelivers: false }, state);
  assert.equal(state.resumeAttempts.get("ENG-1")?.length, 1);
});

test("when the row's pane is a sibling non-claude window, the idle claude beside it is nudged", () => {
  const panes = new Map([
    ["%1", info("vim", 50)],
    ["%2", info("claude", 60)],
    ["%3", info("claude", 40)],
  ]);
  const { nudged } = run({ events: [paneEvent("%1")], panes, canNudge: true });
  assert.deepEqual(nudged.map((n) => n.pane), ["%3"]);
});

test("an exited claude is resumed, not nudged, even when nudging is allowed", () => {
  const { resumed, nudged } = run({ events: [paneEvent("%1")], panes: pane("zsh"), canNudge: true });
  assert.deepEqual(resumed, ["%1"]);
  assert.deepEqual(nudged, []);
});

const turnEnded = (ageMin: number, transcript?: string, pane = "%1"): YimbotEvent => ({
  ts: NOW - ageMin * MIN,
  kind: "turn_ended",
  key: "ENG-1",
  label: "ENG-1",
  pane,
  ...(transcript ? { transcript } : {}),
});
const inputAt = (ageMin: number, pane = "%1"): YimbotEvent => ({ ts: NOW - ageMin * MIN, kind: "input_received", key: "ENG-1", label: "ENG-1", pane });

test("a turn ended long ago is idle even when the screen just redrew (someone viewed the pane)", () => {
  const { emitted, nudged } = run({ events: [turnEnded(45)], panes: pane("claude", 0), canNudge: true });
  assert.deepEqual(emitted.map((e) => [e.kind, e.reason]), [["session_stuck", "no activity 45m"]]);
  assert.deepEqual(nudged.map((n) => n.pane), ["%1"]);
});

test("a stuck row stays stuck when only the screen redraws after its turn ended", () => {
  const { emitted } = run({
    rows: [row({ status: "stuck", stuckReason: "no activity 40m" })],
    events: [turnEnded(45)],
    panes: pane("claude", 0),
  });
  assert.deepEqual(emitted, []);
});

test("a recent turn end is not idle, however quiet the screen", () => {
  const { emitted } = run({ events: [turnEnded(5)], panes: pane("claude", 60) });
  assert.deepEqual(emitted, []);
});

test("a recent transcript write (e.g. a background agent) keeps an ended turn active", () => {
  const { emitted } = run({ events: [turnEnded(45, "/t/s.jsonl")], panes: pane("claude", 60), writes: { "/t/s.jsonl": NOW - 2 * MIN } });
  assert.deepEqual(emitted, []);
});

test("an old transcript write does not rescue an ended turn", () => {
  const { emitted } = run({ events: [turnEnded(45, "/t/s.jsonl")], panes: pane("claude", 0), writes: { "/t/s.jsonl": NOW - 50 * MIN } });
  assert.deepEqual(emitted.map((e) => e.reason), ["no activity 45m"]);
});

test("input after the turn end means mid-turn: screen output decides again", () => {
  const busy = run({ events: [turnEnded(45), inputAt(40)], panes: pane("claude", 1) });
  assert.deepEqual(busy.emitted, []);
  const quiet = run({ events: [turnEnded(45), inputAt(40)], panes: pane("claude", 35) });
  assert.deepEqual(quiet.emitted.map((e) => e.reason), ["no activity 35m"]);
});

test("a stuck row whose nudge was taken (input_received, screen busy) is healthy again", () => {
  const { emitted } = run({
    rows: [row({ status: "stuck", stuckReason: "no activity 45m" })],
    events: [turnEnded(45), inputAt(0)],
    panes: pane("claude", 0),
  });
  assert.deepEqual(emitted.map((e) => e.kind), ["session_resumed"]);
});

test("a turn end from an older pane is ignored once the row moved to a new pane", () => {
  const panes = new Map([["%2", info("claude", 1)]]);
  const { emitted } = run({ events: [turnEnded(45, undefined, "%1"), paneEvent("%2", "ENG-1", "input_received")], panes });
  assert.deepEqual(emitted, []);
});

test("transcriptLastWriteMs takes the newest of the transcript and its subagents", () => {
  const dir = tempDir("transcript-");
  const transcript = join(dir, "s.jsonl");
  writeFileSync(transcript, "{}");
  const t = (ms: number) => new Date(ms);
  utimesSync(transcript, t(NOW - 40 * MIN), t(NOW - 40 * MIN));
  assert.equal(transcriptLastWriteMs(transcript), NOW - 40 * MIN);
  mkdirSync(join(dir, "s", "subagents"), { recursive: true });
  const agent = join(dir, "s", "subagents", "agent-a.jsonl");
  writeFileSync(agent, "{}");
  utimesSync(agent, t(NOW - 3 * MIN), t(NOW - 3 * MIN));
  assert.equal(transcriptLastWriteMs(transcript), NOW - 3 * MIN);
  assert.equal(transcriptLastWriteMs(join(dir, "missing.jsonl")), null);
});
