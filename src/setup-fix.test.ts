import assert from "node:assert/strict";
import { test } from "node:test";
import { installHint, type CheckResult, type Prerequisite } from "./setup-core.ts";
import { walkFixes, type FixEvent } from "./setup-fix.ts";

const pr = (key: string): Prerequisite => ({ key, label: key, severity: "required" });
const item = (key: string, ok: boolean): CheckResult => ({ pr: pr(key), ok });

function harness(opts: { codes?: Record<string, number | undefined>; rechecks?: Record<string, boolean> } = {}) {
  const events: FixEvent[] = [];
  const ran: string[][] = [];
  const rechecked: string[] = [];
  const deps = {
    pm: "pacman" as const,
    run: async (argv: string[]) => {
      ran.push(argv);
      return opts.codes && argv.join(" ") in opts.codes ? opts.codes[argv.join(" ")] : 0;
    },
    recheck: async (p: Prerequisite) => {
      rechecked.push(p.key);
      return opts.rechecks?.[p.key] ?? true;
    },
    emit: (e: FixEvent) => events.push(e),
  };
  return { events, ran, rechecked, deps };
}

test("walkFixes skips satisfied items without running anything", async () => {
  const h = harness();
  const res = await walkFixes([item("gh", true), item("jq", true)], h.deps);
  assert.deepEqual(res, { stoppedAt: null });
  assert.equal(h.ran.length, 0);
  assert.equal(h.events.length, 0);
});

test("walkFixes runs unsatisfied items in order and emits start then ok", async () => {
  const h = harness();
  const res = await walkFixes([item("gh-auth", false), item("gh", true), item("gh-auth", false)], h.deps);
  assert.deepEqual(res, { stoppedAt: null });
  assert.deepEqual(h.ran, [["gh", "auth", "login"], ["gh", "auth", "login"]]);
  assert.deepEqual(h.events.map((e) => e.kind), ["start", "ok", "start", "ok"]);
  assert.deepEqual((h.events[0] as { argv: string[] }).argv, ["gh", "auth", "login"]);
});

test("walkFixes stops on a non-zero exit and does not run later items", async () => {
  const h = harness({ codes: { "gh auth login": 1 } });
  const first = item("gh-auth", false);
  const res = await walkFixes([first, item("gh-auth", false)], h.deps);
  assert.deepEqual(res, { stoppedAt: first.pr });
  assert.equal(h.ran.length, 1);
  assert.deepEqual(h.events.map((e) => e.kind), ["start", "failed"]);
  assert.deepEqual(h.events[1], { kind: "failed", pr: first.pr, code: 1 });
  assert.equal(h.rechecked.length, 0);
});

test("walkFixes reports an undefined exit code as failed", async () => {
  const h = harness({ codes: { "gh auth login": undefined } });
  const first = item("gh-auth", false);
  const res = await walkFixes([first], h.deps);
  assert.deepEqual(res, { stoppedAt: first.pr });
  assert.deepEqual(h.events[1], { kind: "failed", pr: first.pr, code: undefined });
});

test("walkFixes fails when recheck is false after a zero exit", async () => {
  const h = harness({ rechecks: { "gh-auth": false } });
  const first = item("gh-auth", false);
  const res = await walkFixes([first, item("gh-auth", false)], h.deps);
  assert.deepEqual(res, { stoppedAt: first.pr });
  assert.equal(h.ran.length, 1);
  assert.deepEqual(h.events[1], { kind: "failed", pr: first.pr, code: 0 });
});

test("walkFixes emits manual with the install hint and continues", async () => {
  const h = harness();
  const nofix = item("no-such-tool", false);
  const res = await walkFixes([nofix, item("gh-auth", false)], { ...h.deps, pm: null });
  assert.deepEqual(res, { stoppedAt: null });
  assert.deepEqual(h.events[0], { kind: "manual", pr: nofix.pr, hint: installHint("no-such-tool", null) });
  assert.deepEqual(h.events.slice(1).map((e) => e.kind), ["start", "ok"]);
});
