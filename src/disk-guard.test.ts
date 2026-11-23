import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDisk, freshDiskGuardState, parseDiskGb, spaceOf, volumes, type FreeSpace } from "./disk-guard.ts";
import { tempDir } from "./test-temp.ts";

const GB = 1e9;

function guard(samples: (number | null)[], sizeGb = 1000) {
  const state = freshDiskGuardState();
  const logs: string[] = [];
  let relieved = 0;
  const lows: boolean[] = [];
  const step = async () => {
    const bytes = samples.shift();
    const spaces: FreeSpace[] = bytes === null || bytes === undefined ? [] : [{ path: "/tmp", bytes: bytes * GB, size: sizeGb * GB }];
    await checkDisk(state, {
      free: async () => spaces,
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

test("a volume smaller than the marks gets marks scaled to its size, so it can recover", async () => {
  // 32G tmpfs: low at a quarter (8G), recovered at half (16G).
  const g = guard([18.5, 7, 15.9, 16], 32);
  for (let i = 0; i < 4; i++) await g.step();
  assert.deepEqual(g.lows, [false, true, true, false]);
  assert.match(g.logs[0], /disk low: 7\.0G free on \/tmp \(< 8\.0G\).*until 16\.0G free/);
});

test("goes low when any volume is short and recovers only once every volume is back", async () => {
  const state = freshDiskGuardState();
  const logs: string[] = [];
  const check = (spaces: FreeSpace[]) =>
    checkDisk(state, { free: async () => spaces, lowBytes: 20 * GB, highBytes: 40 * GB, relieve: async () => {}, log: (m) => logs.push(m) });
  const big = (free: number): FreeSpace => ({ path: "/", bytes: free * GB, size: 1000 * GB });
  const tmp = (free: number): FreeSpace => ({ path: "/tmp", bytes: free * GB, size: 32 * GB });
  await check([big(700), tmp(6)]);
  assert.equal(state.low, true);
  assert.match(logs[0], /on \/tmp/);
  await check([big(30), tmp(20)]);
  assert.equal(state.low, true);
  await check([big(45), tmp(20)]);
  assert.equal(state.low, false);
});

test("volumes stats each path and skips unstattable ones", async () => {
  const stat: Record<string, { bytes: number; size: number } | null> = { "/a": { bytes: 50, size: 100 }, "/c": null };
  assert.deepEqual(await volumes(["/a", "/c"], async (p) => stat[p]), [{ path: "/a", bytes: 50, size: 100 }]);
  assert.deepEqual(await volumes(["/c"], async (p) => stat[p]), []);
});

test("spaceOf reads a real dir and returns null for a missing one", async () => {
  const dir = tempDir("disk-guard-");
  const space = await spaceOf(dir);
  assert.ok(space !== null && space.bytes > 0 && space.size >= space.bytes);
  assert.equal(await spaceOf(`${dir}/nope/nope`), null);
});

test("parseDiskGb falls back on a missing or bad value", () => {
  assert.equal(parseDiskGb("15", 20), 15 * GB);
  assert.equal(parseDiskGb(undefined, 20), 20 * GB);
  assert.equal(parseDiskGb("-1", 20), 20 * GB);
  assert.equal(parseDiskGb("abc", 20), 20 * GB);
});
