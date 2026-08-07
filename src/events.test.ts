import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveKey, titleFromBranch, statusFor, bus, emitEvent, emitStatus, readEvents, eventsLogPath, reduceRows, type YimbotEvent } from "./events.ts";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("deriveKey: identifier wins and is uppercased", () => {
  assert.deepEqual(deriveKey({ identifier: "eng-42" }), { key: "ENG-42", label: "ENG-42" });
});

test("deriveKey: branch normalizes to ticket key", () => {
  assert.deepEqual(deriveKey({ branch: "eng-42-auth-guard" }), { key: "ENG-42", label: "ENG-42" });
  assert.deepEqual(deriveKey({ branch: "SC-7-thing" }), { key: "SC-7", label: "SC-7" });
});

test("deriveKey: branch+pr with ticket slug still unifies on the ticket", () => {
  assert.deepEqual(deriveKey({ branch: "eng-42-x", pr: 128 }), { key: "ENG-42", label: "ENG-42" });
});

test("deriveKey: pr fallback when branch has no ticket slug", () => {
  assert.deepEqual(deriveKey({ branch: "fix/wrike-shared-users", pr: 128 }), {
    key: "pr:128",
    label: "PR #128",
  });
});

test("deriveKey: bare pr", () => {
  assert.deepEqual(deriveKey({ pr: 5 }), { key: "pr:5", label: "PR #5" });
});

test("titleFromBranch strips ticket prefix and humanizes", () => {
  assert.equal(titleFromBranch("eng-42-auth-guard"), "auth guard");
  assert.equal(titleFromBranch("fix/wrike-shared-users"), "fix wrike shared users");
});

test("statusFor maps kinds; only merged is terminal", () => {
  assert.deepEqual(statusFor("task_started"), { status: "working", terminal: false });
  assert.deepEqual(statusFor("review_started"), { status: "addressing review", terminal: false });
  assert.deepEqual(statusFor("ci_fix_started"), { status: "fixing CI", terminal: false });
  assert.deepEqual(statusFor("conflict_fix_started"), { status: "resolving conflict", terminal: false });
  assert.deepEqual(statusFor("blocked_fix_started"), { status: "unblocking", terminal: false });
  assert.deepEqual(statusFor("ready_to_merge"), { status: "ready to merge", terminal: false });
  assert.deepEqual(statusFor("ready_regressed"), { status: "working", terminal: false });
  assert.deepEqual(statusFor("merged"), { status: "merged", terminal: true });
});

function withTmpLog(fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "yimbot-events-"));
  const path = join(dir, "events.jsonl");
  const prev = process.env.EVENTS_LOG;
  process.env.EVENTS_LOG = path;
  try {
    fn(path);
  } finally {
    if (prev === undefined) delete process.env.EVENTS_LOG;
    else process.env.EVENTS_LOG = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("emitEvent appends a line and stamps ts", () => {
  withTmpLog((path) => {
    emitEvent({ kind: "task_started", key: "ENG-1", label: "ENG-1" });
    const rows = readEvents(path);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "task_started");
    assert.equal(typeof rows[0].ts, "number");
  });
});

test("emitEvent truncates to EVENTS_LOG_MAX_LINES", () => {
  withTmpLog((path) => {
    const prev = process.env.EVENTS_LOG_MAX_LINES;
    process.env.EVENTS_LOG_MAX_LINES = "3";
    try {
      for (let i = 0; i < 10; i++) emitEvent({ kind: "task_started", key: `ENG-${i}`, label: `ENG-${i}` });
      assert.equal(readEvents(path).length, 3);
      assert.equal(readEvents(path)[2].key, "ENG-9");
    } finally {
      if (prev === undefined) delete process.env.EVENTS_LOG_MAX_LINES;
      else process.env.EVENTS_LOG_MAX_LINES = prev;
    }
  });
});

test("emitStatus appends the first observation for a key", () => {
  withTmpLog((path) => {
    emitStatus({ kind: "ready_to_merge", key: "ENG-9", label: "ENG-9" });
    assert.equal(readEvents(path).length, 1);
    assert.equal(readEvents(path)[0].kind, "ready_to_merge");
  });
});

test("emitStatus skips an observation that does not change the derived status", () => {
  withTmpLog((path) => {
    emitStatus({ kind: "ci_fix_started", key: "ENG-1", label: "ENG-1" });
    emitStatus({ kind: "ci_fix_started", key: "ENG-1", label: "ENG-1" });
    assert.equal(readEvents(path).length, 1);
  });
});

test("emitStatus dedupes by derived status string, not by kind", () => {
  withTmpLog((path) => {
    // task_started and ready_regressed both derive to "working".
    emitStatus({ kind: "task_started", key: "ENG-1", label: "ENG-1" });
    emitStatus({ kind: "ready_regressed", key: "ENG-1", label: "ENG-1" });
    assert.equal(readEvents(path).length, 1);
  });
});

test("emitStatus appends when the derived status changes", () => {
  withTmpLog((path) => {
    emitStatus({ kind: "ci_fix_started", key: "ENG-1", label: "ENG-1" });
    emitStatus({ kind: "ready_to_merge", key: "ENG-1", label: "ENG-1" });
    assert.deepEqual(
      readEvents(path).map((e) => e.kind),
      ["ci_fix_started", "ready_to_merge"],
    );
  });
});

test("emitStatus tracks the last status per key independently", () => {
  withTmpLog((path) => {
    emitStatus({ kind: "ci_fix_started", key: "A", label: "A" });
    emitStatus({ kind: "ci_fix_started", key: "B", label: "B" });
    assert.equal(readEvents(path).length, 2);
  });
});

test("emitEvent emits on the bus", () => {
  withTmpLog(() => {
    let got: unknown = null;
    const onEvent = (ev: unknown) => (got = ev);
    bus.on("event", onEvent);
    try {
      emitEvent({ kind: "merged", key: "ENG-2", label: "ENG-2" });
      assert.equal((got as { key: string }).key, "ENG-2");
    } finally {
      bus.off("event", onEvent);
    }
  });
});

test("readEvents: missing file -> [] and malformed lines skipped", () => {
  assert.deepEqual(readEvents(join(tmpdir(), "yimbot-nope-does-not-exist.jsonl")), []);
  withTmpLog((path) => {
    writeFileSync(path, '{"ts":1,"kind":"merged","key":"A","label":"A"}\nnot json\n\n');
    const rows = readEvents(path);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key, "A");
  });
});

const ev = (over: Partial<YimbotEvent>): YimbotEvent => ({
  ts: 0,
  kind: "task_started",
  key: "ENG-1",
  label: "ENG-1",
  ...over,
});

test("reduceRows: last-write-wins per key, keeps prior title", () => {
  const rows = reduceRows(
    [
      ev({ ts: 1, kind: "task_started", title: "auth guard" }),
      ev({ ts: 2, kind: "review_started" }),
    ],
    100,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "addressing review");
  assert.equal(rows[0].title, "auth guard");
  assert.equal(rows[0].ts, 2);
});

test("reduceRows: carries pr forward when a later event omits it", () => {
  const rows = reduceRows(
    [
      ev({ ts: 1, kind: "ci_fix_started", pr: 481 }),
      ev({ ts: 2, kind: "merged" }),
    ],
    100,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pr, 481);
});

test("reduceRows: a later event with a new pr overwrites the earlier one", () => {
  const rows = reduceRows(
    [
      ev({ ts: 1, kind: "task_started", pr: 100 }),
      ev({ ts: 2, kind: "review_started", pr: 200 }),
    ],
    100,
  );
  assert.equal(rows[0].pr, 200);
});

test("reduceRows: pr is undefined for a key that never carried one", () => {
  const rows = reduceRows([ev({ ts: 1, kind: "task_started" })], 100);
  assert.equal(rows[0].pr, undefined);
});

test("reduceRows: sorts newest activity first", () => {
  const rows = reduceRows(
    [ev({ key: "A", label: "A", ts: 1 }), ev({ key: "B", label: "B", ts: 5 })],
    100,
  );
  assert.deepEqual(rows.map((r) => r.key), ["B", "A"]);
});

test("reduceRows: terminal rows age out past keepMergedMs", () => {
  const rows = reduceRows([ev({ key: "A", label: "A", kind: "merged", ts: 10 })], 1000, {
    keepMergedMs: 100,
  });
  assert.equal(rows.length, 0);
});

test("reduceRows: non-terminal rows never age out", () => {
  const rows = reduceRows([ev({ key: "A", label: "A", kind: "task_started", ts: 10 })], 1_000_000, {
    keepMergedMs: 100,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "working");
});

test("reduceRows: maxRows drops oldest terminal first", () => {
  const events = [
    ev({ key: "OLD-MERGED", label: "OLD-MERGED", kind: "merged", ts: 1 }),
    ev({ key: "OLD-WORK", label: "OLD-WORK", kind: "task_started", ts: 2 }),
    ev({ key: "NEW", label: "NEW", kind: "task_started", ts: 3 }),
  ];
  const rows = reduceRows(events, 3, { keepMergedMs: 1_000_000, maxRows: 2 });
  assert.deepEqual(rows.map((r) => r.key).sort(), ["NEW", "OLD-WORK"]);
});

test("reduceRows: maxRows of 0 returns empty and does not hang", () => {
  const rows = reduceRows(
    [ev({ key: "A", label: "A", ts: 1 }), ev({ key: "B", label: "B", ts: 2 })],
    100,
    { keepMergedMs: 1_000_000, maxRows: 0 },
  );
  assert.deepEqual(rows, []);
});
