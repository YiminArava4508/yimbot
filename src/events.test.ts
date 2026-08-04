import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveKey, titleFromBranch, statusFor, bus, emitEvent, readEvents, eventsLogPath } from "./events.ts";
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
  assert.deepEqual(statusFor("ready_to_test"), { status: "ready to test", terminal: false });
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
