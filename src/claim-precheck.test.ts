import assert from "node:assert/strict";
import { test } from "node:test";
import { archiveFlagKey, filterArchiveReady, freshPrecheckState, summarizeReport, type PrecheckDeps, type PrecheckResult } from "./claim-precheck.ts";

const MIN = 60_000;

test("archiveFlagKey reads only archive-flag titles", () => {
  assert.equal(archiveFlagKey("Archive `hubspot-call-list-sync` flag in prod"), "hubspot-call-list-sync");
  assert.equal(archiveFlagKey("archive `dealExport` flag in prod"), "dealExport");
  assert.equal(archiveFlagKey("Archive `a.b_c-1` flag"), "a.b_c-1");
  assert.equal(archiveFlagKey("Fix `dealExport` export bug"), null);
  assert.equal(archiveFlagKey("Remove `x` flag code"), null);
  assert.equal(archiveFlagKey("archive deals transactions tabs flag in prod"), null, "no backticked key");
  assert.equal(archiveFlagKey("Archive `bad key` flag"), null);
});

const issue = (n: number, title: string) => ({ id: `id-${n}`, identifier: `ENG-${n}`, title });

function deps(results: Record<string, PrecheckResult | Error>, now = { t: 0 }) {
  const calls: string[] = [];
  const logs: string[] = [];
  const d: PrecheckDeps = {
    check: async (key) => {
      calls.push(key);
      const r = results[key];
      if (r instanceof Error) throw r;
      return r ?? { pass: true, detail: "ok" };
    },
    state: freshPrecheckState(),
    ttlMs: 60 * MIN,
    errorTtlMs: 10 * MIN,
    now: () => now.t,
    log: (m) => logs.push(m),
  };
  const settle = async () => {
    while (d.state.running) await d.state.running;
  };
  return { d, calls, logs, now, settle };
}

const ids = (xs: { identifier: string }[]) => xs.map((i) => i.identifier);

test("an unchecked archive ticket starts its check in the background and is skipped this heartbeat", async () => {
  const { d, calls, settle } = deps({});
  const list = [issue(1, "Archive `f` flag in prod"), issue(2, "Add a button")];
  assert.deepEqual(ids(filterArchiveReady(list, 1, d)), ["ENG-2"]);
  assert.deepEqual(calls, ["f"]);
  await settle();
  assert.deepEqual(ids(filterArchiveReady(list, 1, d)), ["ENG-1"]);
  assert.deepEqual(calls, ["f"]);
});

test("only one check runs at a time", async () => {
  const { d, calls, settle } = deps({});
  const list = [issue(1, "Archive `a` flag in prod"), issue(2, "Archive `b` flag in prod")];
  assert.deepEqual(filterArchiveReady(list, 2, d), []);
  assert.deepEqual(calls, ["a"]);
  await settle();
  filterArchiveReady(list, 2, d);
  assert.deepEqual(calls, ["a", "b"]);
});

test("a failing archive ticket is skipped so the next candidate takes the slot", async () => {
  const { d, logs, settle } = deps({ "old-flag": { pass: false, detail: "key found on origin/main in: flags.ts" } });
  const list = [issue(1, "Archive `old-flag` flag in prod"), issue(2, "Add a button"), issue(3, "Add a field")];
  filterArchiveReady(list, 2, d);
  await settle();
  assert.deepEqual(ids(filterArchiveReady(list, 2, d)), ["ENG-2", "ENG-3"]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /deferring ENG-1: flag-archive precheck for old-flag failed \(key found on origin\/main/);
});

test("non-archive tickets pass straight through and nothing past `need` is checked", () => {
  const { d, calls } = deps({});
  assert.deepEqual(ids(filterArchiveReady([issue(1, "Add a button"), issue(2, "Archive `x` flag in prod")], 1, d)), ["ENG-1"]);
  assert.deepEqual(calls, []);
});

test("a result is cached for the TTL, then re-checked; a failure logs only when fresh", async () => {
  const { d, calls, logs, now, settle } = deps({ f: { pass: false, detail: "prod still references it" } });
  const list = [issue(1, "Archive `f` flag in prod")];
  filterArchiveReady(list, 1, d);
  await settle();
  now.t = 30 * MIN;
  filterArchiveReady(list, 1, d);
  await settle();
  assert.deepEqual(calls, ["f"]);
  assert.equal(logs.length, 1);
  now.t = 61 * MIN;
  filterArchiveReady(list, 1, d);
  await settle();
  assert.deepEqual(calls, ["f", "f"]);
  assert.equal(logs.length, 2);
});

test("a check that throws fails closed and is retried after the shorter error TTL", async () => {
  const { d, calls, logs, now, settle } = deps({ f: new Error("index.lock exists") });
  const list = [issue(1, "Archive `f` flag in prod")];
  filterArchiveReady(list, 1, d);
  await settle();
  assert.deepEqual(filterArchiveReady(list, 1, d), []);
  assert.match(logs[0], /precheck error: Error: index\.lock exists/);
  now.t = 11 * MIN;
  filterArchiveReady(list, 1, d);
  assert.deepEqual(calls, ["f", "f"]);
});

test("stale results are pruned from the cache", async () => {
  const { d, now, settle } = deps({});
  filterArchiveReady([issue(1, "Archive `f` flag in prod")], 1, d);
  await settle();
  assert.equal(d.state.results.size, 1);
  now.t = 61 * MIN;
  filterArchiveReady([issue(2, "Add a button")], 1, d);
  assert.equal(d.state.results.size, 0);
});

const check = (name: string, pass: boolean, detail: string) => ({ name, pass, detail });

test("summarizeReport passes, fails on a real reference, and throws when a check could not run", () => {
  assert.deepEqual(summarizeReport({ pass: true, checks: [check("main-gemini", true, "none")] }), {
    pass: true,
    detail: "reference checks pass",
  });
  assert.deepEqual(summarizeReport({ pass: false, checks: [check("main-gemini", false, "key found on origin/main in: a.ts")] }), {
    pass: false,
    detail: "main-gemini: key found on origin/main in: a.ts",
  });
  assert.throws(
    () => summarizeReport({ pass: false, checks: [check("org-search", false, "check could not run: rate limited")] }),
    /org-search: check could not run: rate limited/,
  );
  const mixed = summarizeReport({
    pass: false,
    checks: [check("main-gemini", false, "key found on origin/main in: a.ts"), check("org-search", false, "check could not run: x")],
  });
  assert.equal(mixed.pass, false, "a real reference wins over an unreadable check");
});
