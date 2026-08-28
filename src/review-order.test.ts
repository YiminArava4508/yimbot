import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fallbackOrder,
  fetchOrder,
  makeOrderFetcher,
  orderCacheKey,
  orderingPrompt,
  parseOrder,
} from "./review-order.ts";

const PRS = [
  { number: 12, title: "[2/2] deploy service", body: "helm bits", additions: 455, deletions: 0 },
  { number: 11, title: "[1/2] add client", body: "client bits", additions: 565, deletions: 0 },
  { number: 20, title: "big schema change", body: "", additions: 1389, deletions: 236 },
  { number: 15, title: "small fix", body: "", additions: 10, deletions: 2 },
];
const NUMBERS = PRS.map((p) => p.number);

test("orderingPrompt lists every PR with number, title, diffstat and body", () => {
  const p = orderingPrompt(PRS);
  for (const pr of PRS) {
    assert.ok(p.includes(`#${pr.number}: ${pr.title} (+${pr.additions}/-${pr.deletions})`));
  }
  assert.ok(p.includes("helm bits"));
  assert.ok(p.includes("ONLY a JSON object"));
});

test("parseOrder survives prose around the JSON and keeps the given order", () => {
  const raw = 'Sure:\n{"order":[{"pr":11,"reason":"base"},{"pr":12,"reason":"builds on 11"},{"pr":15,"reason":"quick"},{"pr":20,"reason":"biggest"}]}\nDone.';
  const o = parseOrder(raw, NUMBERS);
  assert.ok(o);
  assert.deepEqual(
    o.map((e) => e.pr),
    [11, 12, 15, 20],
  );
  assert.equal(o[1].reason, "builds on 11");
});

test("parseOrder drops unknown and duplicate PRs and appends forgotten ones", () => {
  const raw = JSON.stringify({
    order: [
      { pr: 11, reason: "base" },
      { pr: 11, reason: "dup" },
      { pr: 99, reason: "made up" },
      { pr: 20, reason: "big" },
    ],
  });
  const o = parseOrder(raw, NUMBERS);
  assert.ok(o);
  assert.deepEqual(
    o.map((e) => e.pr),
    [11, 20, 12, 15],
  );
  assert.equal(o[2].reason, "");
});

test("parseOrder returns null for junk", () => {
  assert.equal(parseOrder("no json here", NUMBERS), null);
  assert.equal(parseOrder('{"order": "nope"}', NUMBERS), null);
  assert.equal(parseOrder('{"order": []}', NUMBERS), null);
});

test("fallbackOrder puts stack markers first in stack order, then smallest diff first", () => {
  const o = fallbackOrder(PRS);
  assert.deepEqual(
    o.map((e) => e.pr),
    [11, 12, 15, 20],
  );
  for (const e of o) assert.equal(e.reason, "");
});

test("fallbackOrder breaks diff-size ties by PR number", () => {
  const o = fallbackOrder([
    { number: 5, title: "b", body: "", additions: 1, deletions: 0 },
    { number: 3, title: "a", body: "", additions: 1, deletions: 0 },
  ]);
  assert.deepEqual(
    o.map((e) => e.pr),
    [3, 5],
  );
});

test("fetchOrder uses the runner's order and falls back on junk or a throw", async () => {
  const good = async () => '{"order":[{"pr":20,"reason":"r"},{"pr":11,"reason":""},{"pr":12,"reason":""},{"pr":15,"reason":""}]}';
  const ok = await fetchOrder(good, PRS);
  assert.equal(ok.usedFallback, false);
  assert.equal(ok.order[0].pr, 20);

  const junk = await fetchOrder(async () => "garbage", PRS);
  assert.equal(junk.usedFallback, true);
  assert.deepEqual(
    junk.order.map((e) => e.pr),
    [11, 12, 15, 20],
  );

  const thrown = await fetchOrder(async () => {
    throw new Error("claude missing");
  }, PRS);
  assert.equal(thrown.usedFallback, true);
});

test("orderCacheKey is insensitive to PR order", () => {
  assert.equal(orderCacheKey([3, 1, 2]), orderCacheKey([1, 2, 3]));
  assert.notEqual(orderCacheKey([1, 2]), orderCacheKey([1, 2, 3]));
});

test("makeOrderFetcher fetches once per PR set and repaints when the order lands", async () => {
  let metaCalls = 0;
  let runCalls = 0;
  let updates = 0;
  const f = makeOrderFetcher({
    fetchMeta: async (pr) => {
      metaCalls++;
      return { title: `t${pr}`, body: "", additions: pr, deletions: 0 };
    },
    run: async () => {
      runCalls++;
      return '{"order":[{"pr":2,"reason":"first"},{"pr":1,"reason":"second"}]}';
    },
    onUpdate: () => updates++,
  });
  assert.equal(f.get(), null);
  f.ensure([1, 2]);
  f.ensure([2, 1]); // same set, no second fetch
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(metaCalls, 2);
  assert.equal(runCalls, 1);
  assert.equal(updates, 1);
  assert.deepEqual(
    f.get()?.map((e) => e.pr),
    [2, 1],
  );
  f.ensure([2, 1]);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(runCalls, 1);
});

test("makeOrderFetcher clears the order while a new set fetches and falls back to PR number on meta failure", async () => {
  let fail = false;
  const f = makeOrderFetcher({
    fetchMeta: async (pr) => {
      if (fail) throw new Error("gh down");
      return { title: `t${pr}`, body: "", additions: 1, deletions: 0 };
    },
    run: async () => '{"order":[{"pr":1,"reason":"only"}]}',
    onUpdate: () => {},
  });
  f.ensure([1]);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(
    f.get()?.map((e) => e.pr),
    [1],
  );
  fail = true;
  f.ensure([5, 4]);
  assert.equal(f.get(), null); // stale order never shown against the new set
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(
    f.get()?.map((e) => e.pr),
    [4, 5],
  );
});

test("makeOrderFetcher memoizes past sets, so returning to one refetches nothing", async () => {
  let runCalls = 0;
  const f = makeOrderFetcher({
    fetchMeta: async (pr) => ({ title: `t${pr}`, body: "", additions: 1, deletions: 0 }),
    run: async (prompt) => {
      runCalls++;
      const pr = prompt.includes("#1:") ? 1 : 2;
      return `{"order":[{"pr":${pr},"reason":"only"}]}`;
    },
    onUpdate: () => {},
  });
  f.ensure([1]);
  await new Promise((r) => setTimeout(r, 0));
  f.ensure([2]);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(runCalls, 2);
  f.ensure([1]);
  assert.deepEqual(
    f.get()?.map((e) => e.pr),
    [1],
  ); // served from cache, immediately
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(runCalls, 2);
});

test("makeOrderFetcher does not start a duplicate fetch while the same set is in flight", async () => {
  let metaCalls = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const f = makeOrderFetcher({
    fetchMeta: async (pr) => {
      metaCalls++;
      await gate;
      return { title: `t${pr}`, body: "", additions: 1, deletions: 0 };
    },
    run: async () => '{"order":[{"pr":1,"reason":"r"}]}',
    onUpdate: () => {},
  });
  f.ensure([1]);
  f.ensure([2]);
  f.ensure([1]); // set flapped back while the first fetch is still pending
  assert.equal(metaCalls, 2); // one meta read per PR, not a restarted [1] fetch
  release!();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(
    f.get()?.map((e) => e.pr),
    [1],
  );
});

test("makeOrderFetcher still orders the readable PRs when one meta read fails", async () => {
  const f = makeOrderFetcher({
    fetchMeta: async (pr) => {
      if (pr === 4) throw new Error("gh: pr not found");
      return { title: `t${pr}`, body: "", additions: 1, deletions: 0 };
    },
    run: async () => '{"order":[{"pr":5,"reason":"r"}]}',
    onUpdate: () => {},
  });
  f.ensure([5, 4]);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(
    f.get()?.map((e) => e.pr),
    [5],
  );
});

test("makeOrderFetcher with an empty set clears without fetching", async () => {
  let metaCalls = 0;
  const f = makeOrderFetcher({
    fetchMeta: async () => {
      metaCalls++;
      return { title: "t", body: "", additions: 1, deletions: 0 };
    },
    run: async () => "{}",
    onUpdate: () => {},
  });
  f.ensure([]);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.get(), null);
  assert.equal(metaCalls, 0);
});
