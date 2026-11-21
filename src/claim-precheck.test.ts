import assert from "node:assert/strict";
import { test } from "node:test";
import { archiveFlagKey, filterArchiveReady, type PrecheckDeps, type PrecheckResult } from "./claim-precheck.ts";

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
    cache: new Map(),
    ttlMs: 60 * MIN,
    errorTtlMs: 10 * MIN,
    now: () => now.t,
    log: (m) => logs.push(m),
  };
  return { d, calls, logs, now };
}

test("a failing archive ticket is skipped so the next candidate takes the slot", async () => {
  const { d, logs } = deps({ "old-flag": { pass: false, detail: "key found on origin/main in: flags.ts" } });
  const out = await filterArchiveReady(
    [issue(1, "Archive `old-flag` flag in prod"), issue(2, "Add a button"), issue(3, "Archive `gone-flag` flag in prod")],
    2,
    d,
  );
  assert.deepEqual(out.map((i) => i.identifier), ["ENG-2", "ENG-3"]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /deferring ENG-1: flag-archive precheck for old-flag failed \(key found on origin\/main/);
});

test("non-archive tickets pass straight through and nothing past `need` is checked", async () => {
  const { d, calls } = deps({});
  const out = await filterArchiveReady([issue(1, "Add a button"), issue(2, "Archive `x` flag in prod")], 1, d);
  assert.deepEqual(out.map((i) => i.identifier), ["ENG-1"]);
  assert.deepEqual(calls, []);
});

test("a result is cached for the TTL, then re-checked; a failure logs only when fresh", async () => {
  const { d, calls, logs, now } = deps({ f: { pass: false, detail: "prod still references it" } });
  const list = [issue(1, "Archive `f` flag in prod")];
  await filterArchiveReady(list, 1, d);
  now.t = 30 * MIN;
  await filterArchiveReady(list, 1, d);
  assert.deepEqual(calls, ["f"]);
  assert.equal(logs.length, 1);
  now.t = 61 * MIN;
  await filterArchiveReady(list, 1, d);
  assert.deepEqual(calls, ["f", "f"]);
  assert.equal(logs.length, 2);
});

test("a check that throws fails closed and is retried after the shorter error TTL", async () => {
  const { d, calls, logs, now } = deps({ f: new Error("index.lock exists") });
  const list = [issue(1, "Archive `f` flag in prod")];
  assert.deepEqual(await filterArchiveReady(list, 1, d), []);
  assert.match(logs[0], /precheck error: Error: index\.lock exists/);
  now.t = 11 * MIN;
  await filterArchiveReady(list, 1, d);
  assert.deepEqual(calls, ["f", "f"]);
});

test("a passing archive ticket is claimable and its pass is cached", async () => {
  const { d, calls } = deps({ f: { pass: true, detail: "no code references" } });
  const list = [issue(1, "Archive `f` flag in prod")];
  assert.deepEqual((await filterArchiveReady(list, 1, d)).map((i) => i.identifier), ["ENG-1"]);
  assert.deepEqual((await filterArchiveReady(list, 1, d)).map((i) => i.identifier), ["ENG-1"]);
  assert.deepEqual(calls, ["f"]);
});
