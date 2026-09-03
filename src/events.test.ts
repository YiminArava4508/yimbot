import assert from "node:assert/strict";
import { test } from "node:test";
import { branchesFullyMerged, currentStatus, isHoldStatus, deriveKey, titleFromBranch, statusFor, sectionFor, sectionKind, bus, emitEvent, emitFlagged, emitQueuedToMerge, emitSection, emitStatus, foldAttention, foldSections, readEvents, eventsLogPath, reduceRows, filterToLiveWorktrees, isFlagged, pinEventsLog, type BoardRow, type YimbotEvent } from "./events.ts";
import { writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempDir } from "./test-temp.ts";

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

test("branchesFullyMerged holds back a merged branch while another PR on its row is open", () => {
  const merged = new Set(["sc-1234-thing-part-1"]);
  const open = new Set(["sc-1234-thing-part-2", "sc-1234-thing-part-3"]);
  assert.deepEqual(branchesFullyMerged(merged, open), []);
});

test("branchesFullyMerged releases the key once no open PR shares it", () => {
  const merged = new Set(["sc-1234-thing-part-1", "sc-1234-thing-part-2", "sc-1234-thing-part-3"]);
  assert.deepEqual(
    branchesFullyMerged(merged, new Set()).sort(),
    ["sc-1234-thing-part-1", "sc-1234-thing-part-2", "sc-1234-thing-part-3"],
  );
});

test("branchesFullyMerged only holds back branches sharing the open row key", () => {
  const merged = new Set(["eng-9-solo", "sc-1234-thing-part-1"]);
  const open = new Set(["sc-1234-thing-part-2"]);
  assert.deepEqual(branchesFullyMerged(merged, open), ["eng-9-solo"]);
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
  assert.deepEqual(statusFor("draft_pr"), { status: "draft pr", terminal: false });
  assert.deepEqual(statusFor("ready_regressed"), { status: "working", terminal: false });
  assert.deepEqual(statusFor("awaiting_slices"), { status: "waiting on slices", terminal: false });
  assert.deepEqual(statusFor("merged"), { status: "merged", terminal: true });
});

test("currentStatus reads the key's last status, ignoring non-status events", () => {
  const events: YimbotEvent[] = [
    { ts: 1, kind: "task_started", key: "ENG-1", label: "ENG-1" },
    { ts: 2, kind: "ready_to_merge", key: "ENG-1", label: "ENG-1" },
    { ts: 3, kind: "section_merge", key: "ENG-1", label: "ENG-1" },
    { ts: 4, kind: "flagged", key: "ENG-1", label: "ENG-1" },
    { ts: 5, kind: "task_started", key: "ENG-2", label: "ENG-2" },
  ];
  assert.equal(currentStatus("ENG-1", events), "ready to merge");
  assert.equal(currentStatus("ENG-2", events), "working");
  assert.equal(currentStatus("ENG-3", events), undefined);
});

test("statusFor returns undefined for a kind retired in a newer build", () => {
  // events.jsonl persists across versions, so it can hold kinds this build no
  // longer knows (e.g. the removed ready_to_test). statusFor must not throw.
  assert.equal(statusFor("ready_to_test"), undefined);
  assert.equal(statusFor("totally_unknown"), undefined);
});

test("reduceRows skips a retired-kind event instead of crashing on it", () => {
  const ev = (kind: string, ts: number): YimbotEvent => ({
    ts,
    kind: kind as YimbotEvent["kind"],
    key: "ENG-9",
    label: "ENG-9",
  });
  // A known event alongside a retired one: the known status wins, no crash.
  const rows = reduceRows([ev("ready_to_test", 1), ev("task_started", 2)], 1000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "working");
  // A lone retired-kind event yields no row at all.
  assert.deepEqual(reduceRows([ev("ready_to_test", 1)], 1000), []);
});

function withTmpLog(fn: (path: string) => void): void {
  const dir = tempDir("yimbot-events-");
  const path = join(dir, "events.jsonl");
  const prev = process.env.EVENTS_LOG;
  process.env.EVENTS_LOG = path;
  try {
    fn(path);
  } finally {
    if (prev === undefined) delete process.env.EVENTS_LOG;
    else process.env.EVENTS_LOG = prev;
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

test("emitStatus emits when the last logged kind is one this build no longer knows", () => {
  withTmpLog((path) => {
    // A retired kind persisted by an older build must not make the dedupe throw
    // or wrongly suppress the new observation.
    writeFileSync(path, JSON.stringify({ ts: 1, kind: "ready_to_test", key: "ENG-9", label: "ENG-9" }) + "\n");
    emitStatus({ kind: "ready_to_merge", key: "ENG-9", label: "ENG-9" });
    assert.deepEqual(
      readEvents(path).map((e) => e.kind),
      ["ready_to_test", "ready_to_merge"],
    );
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

test("emitFlagged raises the flag with its reason for an unflagged key", () => {
  withTmpLog((path) => {
    emitFlagged({ key: "ENG-1", label: "ENG-1", reason: "changes-requested" });
    const rows = readEvents(path);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "flagged");
    assert.equal(rows[0].reason, "changes-requested");
  });
});

test("emitFlagged is a no-op while the same reason is already raised", () => {
  withTmpLog((path) => {
    emitFlagged({ key: "ENG-1", label: "ENG-1", reason: "changes-requested" });
    emitFlagged({ key: "ENG-1", label: "ENG-1", reason: "changes-requested" });
    assert.equal(readEvents(path).length, 1);
  });
});

test("emitFlagged appends a second distinct reason on an already-flagged key", () => {
  withTmpLog((path) => {
    emitEvent({ kind: "needs_input", key: "ENG-1", label: "ENG-1" });
    emitFlagged({ key: "ENG-1", label: "ENG-1", reason: "changes-requested" });
    assert.deepEqual(
      readEvents(path).map((e) => e.kind),
      ["needs_input", "flagged"],
    );
  });
});

test("emitFlagged dedupes against a legacy needs_input via its default reason", () => {
  withTmpLog((path) => {
    emitEvent({ kind: "needs_input", key: "ENG-1", label: "ENG-1" });
    emitFlagged({ key: "ENG-1", label: "ENG-1", reason: "input" });
    assert.equal(readEvents(path).length, 1);
  });
});

test("emitFlagged re-raises after a manual unflag", () => {
  withTmpLog((path) => {
    emitFlagged({ key: "ENG-1", label: "ENG-1", reason: "changes-requested" });
    emitEvent({ kind: "unflagged", key: "ENG-1", label: "ENG-1" });
    emitFlagged({ key: "ENG-1", label: "ENG-1", reason: "changes-requested" });
    assert.deepEqual(
      readEvents(path).map((e) => e.kind),
      ["flagged", "unflagged", "flagged"],
    );
  });
});

test("trimming the log preserves each key's newest clear event", () => {
  withTmpLog((path) => {
    const prev = process.env.EVENTS_LOG_MAX_LINES;
    process.env.EVENTS_LOG_MAX_LINES = "3";
    try {
      emitEvent({ kind: "flagged", key: "ENG-1", label: "ENG-1", reason: "human-comment", ts: 100 });
      emitEvent({ kind: "unflagged", key: "ENG-1", label: "ENG-1", ts: 200 });
      emitEvent({ kind: "task_started", key: "A", label: "A", ts: 300 });
      emitEvent({ kind: "task_started", key: "B", label: "B", ts: 400 });
      emitEvent({ kind: "task_started", key: "C", label: "C", ts: 500 });
      // The unflagged line at ts 200 fell past the 3-line cap, but the trim
      // must keep it: it is ENG-1's acknowledgment, and losing it would let an
      // already-acknowledged signal re-raise the flag.
      assert.equal(foldAttention(readEvents(path)).get("ENG-1")?.clearedAt, 200);
      emitFlagged({ key: "ENG-1", label: "ENG-1", reason: "human-comment", signalTs: 150 });
      assert.equal(readEvents(path).filter((e) => e.kind === "flagged").length, 0);
    } finally {
      if (prev === undefined) delete process.env.EVENTS_LOG_MAX_LINES;
      else process.env.EVENTS_LOG_MAX_LINES = prev;
    }
  });
});

test("trimming drops a key's older clear once a newer one is retained", () => {
  withTmpLog((path) => {
    const prev = process.env.EVENTS_LOG_MAX_LINES;
    process.env.EVENTS_LOG_MAX_LINES = "3";
    try {
      emitEvent({ kind: "unflagged", key: "ENG-1", label: "ENG-1", ts: 100 });
      emitEvent({ kind: "task_started", key: "A", label: "A", ts: 200 });
      emitEvent({ kind: "unflagged", key: "ENG-1", label: "ENG-1", ts: 300 });
      emitEvent({ kind: "task_started", key: "B", label: "B", ts: 400 });
      emitEvent({ kind: "task_started", key: "C", label: "C", ts: 500 });
      const clears = readEvents(path).filter((e) => e.kind === "unflagged");
      assert.deepEqual(clears.map((e) => e.ts), [300]);
    } finally {
      if (prev === undefined) delete process.env.EVENTS_LOG_MAX_LINES;
      else process.env.EVENTS_LOG_MAX_LINES = prev;
    }
  });
});

test("foldAttention records the last clear timestamp per key", () => {
  withTmpLog(() => {
    emitEvent({ kind: "flagged", key: "ENG-1", label: "ENG-1", reason: "manual", ts: 100 });
    emitEvent({ kind: "unflagged", key: "ENG-1", label: "ENG-1", ts: 200 });
    emitEvent({ kind: "needs_input", key: "ENG-2", label: "ENG-2", ts: 300 });
    const att = foldAttention(readEvents());
    assert.equal(att.get("ENG-1")?.clearedAt, 200);
    assert.equal(att.get("ENG-1")?.reasons.size, 0);
    assert.equal(att.get("ENG-2")?.clearedAt, null);
    assert.deepEqual([...(att.get("ENG-2")?.reasons ?? [])], ["input"]);
  });
});

test("emitFlagged with a signal at or before the last clear stays down", () => {
  withTmpLog((path) => {
    emitEvent({ kind: "flagged", key: "ENG-1", label: "ENG-1", reason: "human-comment", ts: 100 });
    emitEvent({ kind: "unflagged", key: "ENG-1", label: "ENG-1", ts: 200 });
    emitFlagged({ key: "ENG-1", label: "ENG-1", reason: "human-comment", signalTs: 150 });
    emitFlagged({ key: "ENG-1", label: "ENG-1", reason: "human-comment", signalTs: 200 });
    assert.deepEqual(
      readEvents(path).map((e) => e.kind),
      ["flagged", "unflagged"],
    );
  });
});

test("emitFlagged with a signal newer than the last clear re-raises", () => {
  withTmpLog((path) => {
    emitEvent({ kind: "flagged", key: "ENG-1", label: "ENG-1", reason: "human-comment", ts: 100 });
    emitEvent({ kind: "unflagged", key: "ENG-1", label: "ENG-1", ts: 200 });
    emitFlagged({ key: "ENG-1", label: "ENG-1", reason: "human-comment", signalTs: 250 });
    assert.deepEqual(
      readEvents(path).map((e) => e.kind),
      ["flagged", "unflagged", "flagged"],
    );
  });
});

test("emitFlagged with a signal and no prior clear raises normally", () => {
  withTmpLog((path) => {
    emitFlagged({ key: "ENG-1", label: "ENG-1", reason: "human-comment", signalTs: 50 });
    assert.equal(readEvents(path).length, 1);
  });
});

test("emitFlagged tracks flag state per key independently", () => {
  withTmpLog((path) => {
    emitEvent({ kind: "flagged", key: "A", label: "A", reason: "manual" });
    emitFlagged({ key: "B", label: "B", reason: "manual" });
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

test("reduceRows: a merged key with live manual work shows working (manual) instead of aging out", () => {
  const rows = reduceRows([ev({ key: "A", label: "A", kind: "merged", ts: 10 })], 1000, {
    keepMergedMs: 100,
    manualLiveKeys: new Set(["A"]),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "working (manual)");
  assert.equal(rows[0].terminal, false);
});

test("reduceRows: manual conversion applies inside the merged linger window too", () => {
  const rows = reduceRows([ev({ key: "A", label: "A", kind: "merged", ts: 10 })], 50, {
    keepMergedMs: 100,
    manualLiveKeys: new Set(["A"]),
  });
  assert.equal(rows[0].status, "working (manual)");
});

test("reduceRows: manual live keys leave non-terminal rows untouched", () => {
  const rows = reduceRows([ev({ key: "A", label: "A", kind: "task_started", ts: 10 })], 50, {
    manualLiveKeys: new Set(["A"]),
  });
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

test("filterToLiveWorktrees: non-terminal row kept only when its key is live", () => {
  const row = (over: Partial<BoardRow>): BoardRow => ({
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
  const rows = [row({ key: "ENG-1" }), row({ key: "ENG-2" })];
  const kept = filterToLiveWorktrees(rows, new Set(["ENG-1"]));
  assert.deepEqual(kept.map((r) => r.key), ["ENG-1"]);
});

test("filterToLiveWorktrees: terminal row kept even with no live worktree", () => {
  const merged: BoardRow = {
    key: "ENG-9",
    label: "ENG-9",
    status: "merged",
    terminal: true,
    section: "merge",
    ts: 0,
    startTs: 0,
    flagged: false,
    flagReasons: [],
  };
  assert.deepEqual(filterToLiveWorktrees([merged], new Set()), [merged]);
});

test("reduceRows: maxRows of 0 returns empty and does not hang", () => {
  const rows = reduceRows(
    [ev({ key: "A", label: "A", ts: 1 }), ev({ key: "B", label: "B", ts: 2 })],
    100,
    { keepMergedMs: 1_000_000, maxRows: 0 },
  );
  assert.deepEqual(rows, []);
});

test("reduceRows sets startTs to the earliest event of the spell", () => {
  const rows = reduceRows(
    [
      { ts: 1000, kind: "task_started", key: "ENG-1", label: "ENG-1" },
      { ts: 5000, kind: "ci_fix_started", key: "ENG-1", label: "ENG-1" },
    ],
    9000,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].startTs, 1000);
  assert.equal(rows[0].ts, 5000);
});

test("reduceRows resets startTs after a merged event", () => {
  const rows = reduceRows(
    [
      { ts: 1000, kind: "task_started", key: "ENG-1", label: "ENG-1" },
      { ts: 2000, kind: "merged", key: "ENG-1", label: "ENG-1" },
      { ts: 8000, kind: "task_started", key: "ENG-1", label: "ENG-1" },
    ],
    9000,
    { keepMergedMs: 0 },
  );
  assert.equal(rows[0].startTs, 8000);
  assert.equal(rows[0].terminal, false);
});

test("manual flag folds to flagged; a later unflag clears it", () => {
  const flag = reduceRows(
    [
      { ts: 1000, kind: "task_started", key: "ENG-1", label: "ENG-1" },
      { ts: 2000, kind: "flagged", key: "ENG-1", label: "ENG-1" },
    ],
    4000,
  );
  assert.equal(flag[0].flagged, true);
  const cleared = reduceRows(
    [
      { ts: 1000, kind: "task_started", key: "ENG-1", label: "ENG-1" },
      { ts: 2000, kind: "flagged", key: "ENG-1", label: "ENG-1" },
      { ts: 3000, kind: "unflagged", key: "ENG-1", label: "ENG-1" },
    ],
    4000,
  );
  assert.equal(cleared[0].flagged, false);
});

test("a status event after a manual flag does not clear it", () => {
  const rows = reduceRows(
    [
      { ts: 1000, kind: "task_started", key: "ENG-1", label: "ENG-1" },
      { ts: 2000, kind: "flagged", key: "ENG-1", label: "ENG-1" },
      { ts: 3000, kind: "ci_fix_started", key: "ENG-1", label: "ENG-1" },
    ],
    4000,
  );
  assert.equal(rows[0].flagged, true);
});

test("needs_input raises the flag and never changes status or duration", () => {
  const rows = reduceRows(
    [
      { ts: 1000, kind: "task_started", key: "ENG-1", label: "ENG-1" },
      { ts: 2000, kind: "needs_input", key: "ENG-1", label: "ENG-1" },
    ],
    5000,
  );
  assert.equal(rows[0].flagged, true);
  assert.equal(rows[0].status, "working");
  assert.equal(rows[0].startTs, 1000);
  assert.equal(rows[0].ts, 1000); // needs_input is not a status; last status ts stands
  assert.equal(isFlagged(rows[0]), true);
});

test("needs_input clears only on input or manual unflag, never on a status", () => {
  const clears = (clearer: YimbotEvent) =>
    reduceRows(
      [
        { ts: 1000, kind: "task_started", key: "ENG-1", label: "ENG-1" },
        { ts: 2000, kind: "needs_input", key: "ENG-1", label: "ENG-1" },
        clearer,
      ],
      5000,
    )[0].flagged;
  assert.equal(clears({ ts: 3000, kind: "input_received", key: "ENG-1", label: "ENG-1" }), false);
  assert.equal(clears({ ts: 3000, kind: "unflagged", key: "ENG-1", label: "ENG-1" }), false);
  assert.equal(clears({ ts: 3000, kind: "ci_fix_started", key: "ENG-1", label: "ENG-1" }), true);
  assert.equal(clears({ ts: 3000, kind: "conflict_fix_started", key: "ENG-1", label: "ENG-1" }), true);
});

test("a needs_input after a clear re-raises the flag", () => {
  const rows = reduceRows(
    [
      { ts: 1000, kind: "task_started", key: "ENG-1", label: "ENG-1" },
      { ts: 2000, kind: "needs_input", key: "ENG-1", label: "ENG-1" },
      { ts: 3000, kind: "input_received", key: "ENG-1", label: "ENG-1" },
      { ts: 4000, kind: "needs_input", key: "ENG-1", label: "ENG-1" },
    ],
    5000,
  );
  assert.equal(rows[0].flagged, true);
});

test("reduceRows collects flag reasons in raise order", () => {
  const rows = reduceRows(
    [
      { ts: 1000, kind: "task_started", key: "ENG-1", label: "ENG-1" },
      { ts: 2000, kind: "needs_input", key: "ENG-1", label: "ENG-1", reason: "input" },
      { ts: 3000, kind: "flagged", key: "ENG-1", label: "ENG-1", reason: "changes-requested" },
    ],
    5000,
  );
  assert.equal(rows[0].flagged, true);
  assert.deepEqual(rows[0].flagReasons, ["input", "changes-requested"]);
});

test("reduceRows defaults legacy reason-less raises by kind", () => {
  const rows = reduceRows(
    [
      { ts: 1000, kind: "task_started", key: "ENG-1", label: "ENG-1" },
      { ts: 2000, kind: "needs_input", key: "ENG-1", label: "ENG-1" },
      { ts: 3000, kind: "flagged", key: "ENG-1", label: "ENG-1" },
    ],
    5000,
  );
  assert.deepEqual(rows[0].flagReasons, ["input", "manual"]);
});

test("reduceRows does not repeat a reason raised twice", () => {
  const rows = reduceRows(
    [
      { ts: 1000, kind: "task_started", key: "ENG-1", label: "ENG-1" },
      { ts: 2000, kind: "flagged", key: "ENG-1", label: "ENG-1", reason: "decision" },
      { ts: 3000, kind: "flagged", key: "ENG-1", label: "ENG-1", reason: "decision" },
    ],
    5000,
  );
  assert.deepEqual(rows[0].flagReasons, ["decision"]);
});

test("reduceRows clears every reason on input_received or unflag", () => {
  for (const clearer of ["input_received", "unflagged"] as const) {
    const rows = reduceRows(
      [
        { ts: 1000, kind: "task_started", key: "ENG-1", label: "ENG-1" },
        { ts: 2000, kind: "needs_input", key: "ENG-1", label: "ENG-1", reason: "input" },
        { ts: 3000, kind: "flagged", key: "ENG-1", label: "ENG-1", reason: "decision" },
        { ts: 4000, kind: clearer, key: "ENG-1", label: "ENG-1" },
      ],
      5000,
    );
    assert.equal(rows[0].flagged, false, clearer);
    assert.deepEqual(rows[0].flagReasons, [], clearer);
  }
});

test("pinEventsLog sets an absolute EVENTS_LOG in the environment", () => {
  const dir = tempDir("yimbot-pin-");
  const prev = process.env.EVENTS_LOG;
  try {
    process.env.EVENTS_LOG = join(dir, "events.jsonl");
    const abs = pinEventsLog();
    assert.ok(abs.startsWith("/"));
    assert.equal(process.env.EVENTS_LOG, abs);
  } finally {
    if (prev === undefined) delete process.env.EVENTS_LOG;
    else process.env.EVENTS_LOG = prev;
  }
});

test("needs_decision then flagged folds to the status plus a raised flag", () => {
  const rows = reduceRows(
    [
      { ts: 1000, kind: "review_started", key: "ENG-1", label: "ENG-1" },
      { ts: 2000, kind: "needs_decision", key: "ENG-1", label: "ENG-1" },
      { ts: 2001, kind: "flagged", key: "ENG-1", label: "ENG-1" },
    ],
    5000,
  );
  assert.equal(rows[0].status, "needs decision");
  assert.equal(rows[0].terminal, false);
  assert.equal(rows[0].flagged, true);
});

test("flagged before needs_decision keeps the flag raised (order no longer matters)", () => {
  const rows = reduceRows(
    [
      { ts: 1000, kind: "review_started", key: "ENG-1", label: "ENG-1" },
      { ts: 2000, kind: "flagged", key: "ENG-1", label: "ENG-1" },
      { ts: 2001, kind: "needs_decision", key: "ENG-1", label: "ENG-1" },
    ],
    5000,
  );
  assert.equal(rows[0].status, "needs decision");
  assert.equal(rows[0].flagged, true);
});

test("review_findings then flagged folds to the status plus a raised flag", () => {
  const rows = reduceRows(
    [
      { ts: 1000, kind: "review_started", key: "ENG-1", label: "ENG-1" },
      { ts: 2000, kind: "review_findings", key: "ENG-1", label: "ENG-1" },
      { ts: 2001, kind: "flagged", key: "ENG-1", label: "ENG-1" },
    ],
    5000,
  );
  assert.equal(rows[0].status, "review findings");
  assert.equal(rows[0].flagged, true);
});

test("a clearing event after a hand-back drops the flag but keeps the status", () => {
  const rows = reduceRows(
    [
      { ts: 1000, kind: "review_started", key: "ENG-1", label: "ENG-1" },
      { ts: 2000, kind: "needs_decision", key: "ENG-1", label: "ENG-1" },
      { ts: 2001, kind: "flagged", key: "ENG-1", label: "ENG-1" },
      { ts: 3000, kind: "input_received", key: "ENG-1", label: "ENG-1" },
    ],
    5000,
  );
  assert.equal(rows[0].status, "needs decision");
  assert.equal(rows[0].flagged, false);
});

test("statusFor maps the two hand-back kinds", () => {
  assert.deepEqual(statusFor("needs_decision"), { status: "needs decision", terminal: false });
  assert.deepEqual(statusFor("review_findings"), { status: "review findings", terminal: false });
});

test("refine event kinds map to board statuses", () => {
  assert.deepEqual(statusFor("refine_started"), { status: "refining", terminal: false });
  assert.deepEqual(statusFor("refined"), { status: "refined", terminal: true });
});

test("sectionFor maps only the section kinds", () => {
  assert.equal(sectionFor("section_tasks"), "tasks");
  assert.equal(sectionFor("section_review"), "review");
  assert.equal(sectionFor("section_merge"), "merge");
  assert.equal(sectionFor("ready_to_merge"), undefined);
  assert.equal(sectionFor("totally_unknown"), undefined);
});

test("sectionKind is sectionFor's inverse", () => {
  assert.equal(sectionKind("tasks"), "section_tasks");
  assert.equal(sectionKind("review"), "section_review");
  assert.equal(sectionKind("merge"), "section_merge");
});

test("a section event carries no status, so it never becomes a row on its own", () => {
  assert.equal(statusFor("section_merge"), undefined);
  const ev: YimbotEvent = { ts: 1, kind: "section_merge", key: "ENG-9", label: "ENG-9" };
  assert.deepEqual(reduceRows([ev], 1000), []);
});

test("foldSections takes the newest section event per key", () => {
  const ev = (kind: YimbotEvent["kind"], key: string, ts: number): YimbotEvent => ({ ts, kind, key, label: key });
  const folded = foldSections([
    ev("section_merge", "ENG-1", 1),
    ev("section_review", "ENG-2", 2),
    ev("section_tasks", "ENG-1", 3),
    ev("task_started", "ENG-1", 4),
  ]);
  assert.equal(folded.get("ENG-1"), "tasks");
  assert.equal(folded.get("ENG-2"), "review");
  assert.equal(folded.get("ENG-3"), undefined);
});

test("reduceRows defaults a row with no section event to tasks", () => {
  const rows = reduceRows([{ ts: 1, kind: "ci_fix_started", key: "ENG-1", label: "ENG-1" }], 1000);
  assert.equal(rows[0].section, "tasks");
});

test("reduceRows keeps the folded section while the status moves on", () => {
  // The whole point: a labeled PR whose CI breaks stays in the merge section
  // and only its STATUS changes.
  const rows = reduceRows(
    [
      { ts: 1, kind: "section_merge", key: "ENG-1", label: "ENG-1" },
      { ts: 2, kind: "ready_to_merge", key: "ENG-1", label: "ENG-1" },
      { ts: 3, kind: "ci_fix_started", key: "ENG-1", label: "ENG-1" },
    ],
    1000,
  );
  assert.equal(rows[0].section, "merge");
  assert.equal(rows[0].status, "fixing CI");
});

test("reduceRows moves a row out of merge when the section event says so", () => {
  const rows = reduceRows(
    [
      { ts: 1, kind: "section_merge", key: "ENG-1", label: "ENG-1" },
      { ts: 2, kind: "ready_to_merge", key: "ENG-1", label: "ENG-1" },
      { ts: 3, kind: "section_tasks", key: "ENG-1", label: "ENG-1" },
    ],
    1000,
  );
  assert.equal(rows[0].section, "tasks");
  assert.equal(rows[0].status, "ready to merge");
});

test("reduceRows forces a merged row into the merge section", () => {
  const rows = reduceRows(
    [
      { ts: 1, kind: "section_tasks", key: "ENG-1", label: "ENG-1" },
      { ts: 2, kind: "merged", key: "ENG-1", label: "ENG-1" },
    ],
    1000,
  );
  assert.equal(rows[0].section, "merge");
});

test("reduceRows leaves a manual-live merged row in its folded section", () => {
  const rows = reduceRows(
    [
      { ts: 1, kind: "section_tasks", key: "ENG-1", label: "ENG-1" },
      { ts: 2, kind: "merged", key: "ENG-1", label: "ENG-1" },
    ],
    1000,
    { manualLiveKeys: new Set(["ENG-1"]) },
  );
  assert.equal(rows[0].section, "tasks");
  assert.equal(rows[0].status, "working (manual)");
});

test("a section event does not disturb the row's ts or duration", () => {
  const rows = reduceRows(
    [
      { ts: 100, kind: "task_started", key: "ENG-1", label: "ENG-1" },
      { ts: 900, kind: "section_merge", key: "ENG-1", label: "ENG-1" },
    ],
    1000,
  );
  assert.equal(rows[0].ts, 100);
  assert.equal(rows[0].startTs, 100);
});

test("emitSection appends the first section for a key", () => {
  withTmpLog((path) => {
    emitSection({ kind: "section_merge", key: "ENG-9", label: "ENG-9" });
    assert.deepEqual(readEvents(path).map((e) => e.kind), ["section_merge"]);
  });
});

test("emitSection skips a section that has not changed", () => {
  withTmpLog((path) => {
    emitSection({ kind: "section_merge", key: "ENG-9", label: "ENG-9" });
    emitSection({ kind: "section_merge", key: "ENG-9", label: "ENG-9" });
    assert.equal(readEvents(path).length, 1);
  });
});

test("emitSection appends when the section changes, ignoring interleaved statuses", () => {
  withTmpLog((path) => {
    emitSection({ kind: "section_merge", key: "ENG-9", label: "ENG-9" });
    emitStatus({ kind: "ci_fix_started", key: "ENG-9", label: "ENG-9" });
    emitSection({ kind: "section_merge", key: "ENG-9", label: "ENG-9" });
    emitSection({ kind: "section_tasks", key: "ENG-9", label: "ENG-9" });
    assert.deepEqual(readEvents(path).map((e) => e.kind), ["section_merge", "ci_fix_started", "section_tasks"]);
  });
});

test("emitSection tracks each key independently", () => {
  withTmpLog((path) => {
    emitSection({ kind: "section_merge", key: "A", label: "A" });
    emitSection({ kind: "section_merge", key: "B", label: "B" });
    assert.equal(readEvents(path).length, 2);
  });
});

test("emitStatus dedupes past a trailing section event", () => {
  // emitStatus used to read the key's newest event of ANY kind, so a section
  // (or flag) event landing after the status defeated the dedupe and the same
  // status re-appended every heartbeat.
  withTmpLog((path) => {
    emitStatus({ kind: "ci_fix_started", key: "ENG-1", label: "ENG-1" });
    emitSection({ kind: "section_merge", key: "ENG-1", label: "ENG-1" });
    emitStatus({ kind: "ci_fix_started", key: "ENG-1", label: "ENG-1" });
    assert.deepEqual(readEvents(path).map((e) => e.kind), ["ci_fix_started", "section_merge"]);
  });
});

test("emitStatus dedupes past a trailing flag event", () => {
  withTmpLog((path) => {
    emitStatus({ kind: "ci_fix_started", key: "ENG-1", label: "ENG-1" });
    emitFlagged({ key: "ENG-1", label: "ENG-1", reason: "stuck" });
    emitStatus({ kind: "ci_fix_started", key: "ENG-1", label: "ENG-1" });
    assert.deepEqual(readEvents(path).map((e) => e.kind), ["ci_fix_started", "flagged"]);
  });
});

test("reduceRows leaves a refined row in the tasks section", () => {
  // `refined` is terminal too, but a refined ticket has no PR and never entered
  // the queue: only a merge belongs in the merge pane.
  const rows = reduceRows(
    [
      { ts: 1, kind: "refine_started", key: "ENG-1", label: "ENG-1" },
      { ts: 2, kind: "refined", key: "ENG-1", label: "ENG-1" },
    ],
    1000,
  );
  assert.equal(rows[0].status, "refined");
  assert.equal(rows[0].section, "tasks");
});

test("emitEvent preserves a key's newest section event past the line cap", () => {
  // A queued PR's section event is older than its status lines, so the cap
  // trims it first; without preserving it the row drops into the tasks pane
  // until the next heartbeat re-reports it.
  withTmpLog((path) => {
    const prev = process.env.EVENTS_LOG_MAX_LINES;
    process.env.EVENTS_LOG_MAX_LINES = "3";
    try {
      emitSection({ kind: "section_merge", key: "ENG-1", label: "ENG-1" });
      for (let i = 0; i < 5; i++) emitEvent({ kind: "task_started", key: `OTHER-${i}`, label: `OTHER-${i}` });
      const kinds = readEvents(path).map((e) => e.kind);
      assert.equal(kinds[0], "section_merge");
      assert.equal(foldSections(readEvents(path)).get("ENG-1"), "merge");
    } finally {
      if (prev === undefined) delete process.env.EVENTS_LOG_MAX_LINES;
      else process.env.EVENTS_LOG_MAX_LINES = prev;
    }
  });
});

test("emitEvent keeps only the newest section per key past the cap", () => {
  withTmpLog((path) => {
    const prev = process.env.EVENTS_LOG_MAX_LINES;
    process.env.EVENTS_LOG_MAX_LINES = "2";
    try {
      emitSection({ kind: "section_merge", key: "ENG-1", label: "ENG-1" });
      emitSection({ kind: "section_tasks", key: "ENG-1", label: "ENG-1" });
      for (let i = 0; i < 4; i++) emitEvent({ kind: "task_started", key: `OTHER-${i}`, label: `OTHER-${i}` });
      assert.deepEqual(
        readEvents(path).filter((e) => e.key === "ENG-1").map((e) => e.kind),
        ["section_tasks"],
      );
    } finally {
      if (prev === undefined) delete process.env.EVENTS_LOG_MAX_LINES;
      else process.env.EVENTS_LOG_MAX_LINES = prev;
    }
  });
});

test("emitEvent does not re-preserve a section the kept window still holds", () => {
  withTmpLog((path) => {
    const prev = process.env.EVENTS_LOG_MAX_LINES;
    process.env.EVENTS_LOG_MAX_LINES = "3";
    try {
      emitSection({ kind: "section_merge", key: "ENG-1", label: "ENG-1" });
      emitEvent({ kind: "task_started", key: "A", label: "A" });
      emitSection({ kind: "section_tasks", key: "ENG-1", label: "ENG-1" });
      emitEvent({ kind: "task_started", key: "B", label: "B" });
      assert.deepEqual(
        readEvents(path).filter((e) => e.key === "ENG-1").map((e) => e.kind),
        ["section_tasks"],
      );
    } finally {
      if (prev === undefined) delete process.env.EVENTS_LOG_MAX_LINES;
      else process.env.EVENTS_LOG_MAX_LINES = prev;
    }
  });
});

test("emitQueuedToMerge records both the status and the move to the merge pane", () => {
  withTmpLog((path) => {
    emitQueuedToMerge({ key: "ENG-9", label: "ENG-9", pr: 12 });
    const rows = readEvents(path);
    assert.deepEqual(rows.map((e) => e.kind), ["ready_to_merge", "section_merge"]);
    assert.deepEqual(rows.map((e) => e.pr), [12, 12]);
  });
});

test("emitQueuedToMerge moves the row immediately, without waiting for a heartbeat", () => {
  withTmpLog((path) => {
    emitStatus({ kind: "draft_pr", key: "ENG-9", label: "ENG-9", pr: 12 });
    emitSection({ kind: "section_review", key: "ENG-9", label: "ENG-9", pr: 12 });
    emitQueuedToMerge({ key: "ENG-9", label: "ENG-9", pr: 12 });
    const [row] = reduceRows(readEvents(path), Date.now());
    assert.equal(row.section, "merge");
    assert.equal(row.status, "ready to merge");
  });
});

test("emitQueuedToMerge is idempotent, so a repeat keypress logs nothing", () => {
  withTmpLog((path) => {
    emitQueuedToMerge({ key: "ENG-9", label: "ENG-9", pr: 12 });
    emitQueuedToMerge({ key: "ENG-9", label: "ENG-9", pr: 12 });
    assert.equal(readEvents(path).length, 2);
  });
});

test("isHoldStatus covers the statuses a human is already waiting on", () => {
  assert.equal(isHoldStatus("needs decision"), true);
  assert.equal(isHoldStatus("review findings"), true);
  assert.equal(isHoldStatus("working"), false);
  assert.equal(isHoldStatus("ready to merge"), false);
  assert.equal(isHoldStatus(undefined), false);
});
