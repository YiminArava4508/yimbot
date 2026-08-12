import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLabelFilter } from "./labels.ts";
import { makePrLabelFilter } from "./pr-filter.ts";

const pr = (n: number, branch: string) => ({ number: n, headRefName: branch });

function harness(raw: string | undefined, labels: Record<string, string[]>, opts: { fail?: boolean } = {}) {
  const calls: string[] = [];
  let clock = 0;
  const filter = makePrLabelFilter({
    filter: parseLabelFilter(raw),
    fetchLabels: async (identifier) => {
      calls.push(identifier);
      if (opts.fail) throw new Error("linear down");
      return labels[identifier] ?? [];
    },
    ttlMs: 1000,
    now: () => clock,
    log: () => {},
  });
  return { filter, calls, tick: (ms: number) => void (clock += ms) };
}

test("an include filter keeps only PRs whose ticket carries the label", async () => {
  const { filter } = harness("bot", { "ENG-1": ["bot"], "ENG-2": [] });
  const kept = await filter([pr(1, "eng-1-a"), pr(2, "eng-2-b")]);
  assert.deepEqual(kept.map((p) => p.number), [1]);
});

test("a negated filter drops PRs whose ticket carries the label", async () => {
  const { filter } = harness("!bot", { "ENG-1": ["bot"], "ENG-2": [] });
  const kept = await filter([pr(1, "eng-1-a"), pr(2, "eng-2-b")]);
  assert.deepEqual(kept.map((p) => p.number), [2]);
});

test("no filter passes every PR through without a lookup", async () => {
  const { filter, calls } = harness(undefined, {});
  const kept = await filter([pr(1, "eng-1-a")]);
  assert.deepEqual(kept.map((p) => p.number), [1]);
  assert.deepEqual(calls, []);
});

test("a branch with no ticket identifier counts as unlabelled", async () => {
  const include = harness("bot", {});
  assert.deepEqual((await include.filter([pr(1, "hotfix-login")])).map((p) => p.number), []);
  const exclude = harness("!bot", {});
  assert.deepEqual((await exclude.filter([pr(1, "hotfix-login")])).map((p) => p.number), [1]);
});

test("a failed lookup skips the PR for this tick rather than working it", async () => {
  const { filter } = harness("!bot", {}, { fail: true });
  assert.deepEqual((await filter([pr(1, "eng-1-a")])).map((p) => p.number), []);
});

test("labels are cached until the ttl expires", async () => {
  const { filter, calls, tick } = harness("bot", { "ENG-1": ["bot"] });
  await filter([pr(1, "eng-1-a"), pr(2, "eng-1-b")]);
  await filter([pr(1, "eng-1-a")]);
  assert.deepEqual(calls, ["ENG-1"]);
  tick(1001);
  await filter([pr(1, "eng-1-a")]);
  assert.deepEqual(calls, ["ENG-1", "ENG-1"]);
});
