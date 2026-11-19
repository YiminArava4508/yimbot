import assert from "node:assert/strict";
import { test } from "node:test";
import { createQueueGate, filesOverlap, serializeOverlaps, type QueuedPr } from "./queue-overlap.ts";

const pr = (n: number, ...files: string[]): QueuedPr => ({ n, headSha: `sha${n}`, files });

test("filesOverlap compares exact paths", () => {
  assert.equal(filesOverlap(["a.ts", "b.ts"], ["b.ts"]), true);
  assert.equal(filesOverlap(["a.ts"], ["b.ts"]), false);
  assert.equal(filesOverlap([], ["b.ts"]), false);
});

test("a candidate overlapping an already queued PR is held by it", () => {
  const held = serializeOverlaps([pr(10, "f.ts")], [pr(5, "f.ts")]);
  assert.equal(held.get(5), 10);
});

test("disjoint candidates all queue", () => {
  const held = serializeOverlaps([], [pr(1, "a"), pr(2, "b")]);
  assert.deepEqual([...held.values()], [null, null]);
});

test("among overlapping candidates only the oldest queues", () => {
  const held = serializeOverlaps([], [pr(9, "f"), pr(3, "f"), pr(6, "f")]);
  assert.equal(held.get(3), null);
  assert.equal(held.get(6), 3);
  assert.equal(held.get(9), 3);
});

test("three pairwise-overlapping PRs go through one at a time", async () => {
  const files: Record<number, string[]> = { 8082: ["flags.ts", "a.ts"], 8087: ["flags.ts", "b.ts"], 8090: ["flags.ts", "c.ts"] };
  const open = new Set([8082, 8087, 8090]);
  const queued = new Set<number>();
  const gate = createQueueGate({
    listQueued: async () => [...queued].filter((n) => open.has(n)).map((n) => ({ n, headSha: `s${n}`, files: files[n] })),
    fetchFiles: async (n) => ({ headSha: `s${n}`, files: files[n] }),
    log: () => {},
  });
  const tick = async () => {
    const result = await gate([...open].map((n) => ({ n })));
    for (const [n, holder] of result) if (holder === null) queued.add(n);
    return result;
  };
  let r = await tick();
  assert.deepEqual([r.get(8082), r.get(8087), r.get(8090)], [null, 8082, 8082]);
  r = await tick();
  assert.deepEqual([r.get(8087), r.get(8090)], [8082, 8082]); // 8082 still queued
  open.delete(8082); // merged
  r = await tick();
  assert.deepEqual([r.get(8087), r.get(8090)], [null, 8087]);
  open.delete(8087);
  r = await tick();
  assert.equal(r.get(8090), null);
});

test("file lists are cached by head SHA", async () => {
  let fetches = 0;
  const gate = createQueueGate({
    listQueued: async () => [],
    fetchFiles: async (n) => {
      fetches++;
      return { headSha: "same", files: [`f${n}`] };
    },
    log: () => {},
  });
  await gate([{ n: 1, headSha: "same" }]);
  await gate([{ n: 1, headSha: "same" }]);
  assert.equal(fetches, 1);
  await gate([{ n: 1, headSha: "moved" }]);
  assert.equal(fetches, 2);
});

test("queued PRs seed the cache and a failed file read lets the candidate through", async () => {
  const logs: string[] = [];
  const gate = createQueueGate({
    listQueued: async () => [pr(5, "f")],
    fetchFiles: async () => {
      throw new Error("gh down");
    },
    log: (m) => void logs.push(m),
  });
  const r = await gate([{ n: 7 }]);
  assert.equal(r.get(7), null);
  assert.match(logs.join("\n"), /file list failed for PR #7/);
});
