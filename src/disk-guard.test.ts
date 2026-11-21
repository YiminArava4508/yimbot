import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDisk, freeBytesOf, freshDiskGuardState, parseDiskGb, tightestVolume, type FreeSpace } from "./disk-guard.ts";
import { tempDir } from "./test-temp.ts";

const GB = 1e9;

function guard(samples: (number | null)[]) {
  const state = freshDiskGuardState();
  const logs: string[] = [];
  let relieved = 0;
  const lows: boolean[] = [];
  const step = async () => {
    const bytes = samples.shift();
    const space: FreeSpace | null = bytes === null || bytes === undefined ? null : { path: "/tmp", bytes: bytes * GB };
    await checkDisk(state, {
      free: async () => space,
      lowBytes: 20 * GB,
      highBytes: 40 * GB,
      relieve: async () => void relieved++,
      log: (m) => logs.push(m),
    });
    lows.push(state.low);
  };
  return { step, logs, lows, relieved: () => relieved };
}

test("plenty of space: not low, nothing relieved, nothing logged", async () => {
  const g = guard([100]);
  await g.step();
  assert.deepEqual(g.lows, [false]);
  assert.equal(g.relieved(), 0);
  assert.deepEqual(g.logs, []);
});

test("below the low mark goes low, logs once, and relieves on every low check", async () => {
  const g = guard([10, 12, 15]);
  await g.step();
  await g.step();
  await g.step();
  assert.deepEqual(g.lows, [true, true, true]);
  assert.equal(g.relieved(), 3);
  assert.equal(g.logs.length, 1);
  assert.match(g.logs[0], /disk low: 10\.0G free on \/tmp/);
});

test("stays low between the marks and clears only at the high mark (hysteresis)", async () => {
  const g = guard([10, 30, 39.9, 40, 30]);
  for (let i = 0; i < 5; i++) await g.step();
  assert.deepEqual(g.lows, [true, true, true, false, false]);
  assert.equal(g.relieved(), 3);
  assert.match(g.logs.at(-1)!, /disk recovered: 40\.0G/);
});

test("an unmeasurable sample keeps the last verdict", async () => {
  const g = guard([10, null]);
  await g.step();
  await g.step();
  assert.deepEqual(g.lows, [true, true]);
  assert.equal(g.relieved(), 1);
});

test("tightestVolume picks the smallest and skips unstattable paths", async () => {
  const free: Record<string, number | null> = { "/a": 50, "/b": 5, "/c": null };
  const got = await tightestVolume(["/a", "/b", "/c"], async (p) => free[p]);
  assert.deepEqual(got, { path: "/b", bytes: 5 });
  assert.equal(await tightestVolume(["/c"], async (p) => free[p]), null);
});

test("freeBytesOf reads a real dir and returns null for a missing one", async () => {
  const dir = tempDir("disk-guard-");
  const bytes = await freeBytesOf(dir);
  assert.ok(bytes !== null && bytes > 0);
  assert.equal(await freeBytesOf(`${dir}/nope/nope`), null);
});

test("parseDiskGb falls back on a missing or bad value", () => {
  assert.equal(parseDiskGb("15", 20), 15 * GB);
  assert.equal(parseDiskGb(undefined, 20), 20 * GB);
  assert.equal(parseDiskGb("-1", 20), 20 * GB);
  assert.equal(parseDiskGb("abc", 20), 20 * GB);
});
