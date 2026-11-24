import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { sweepGoBuildDirs, trimGoCache } from "./go-cache.ts";
import { tempDir } from "./test-temp.ts";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-11-18T12:00:00Z");

function entry(path: string, ageHours: number, asDir = false): void {
  if (asDir) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "covdata"), "x");
  } else {
    writeFileSync(path, "x".repeat(10));
  }
  const t = new Date(NOW - ageHours * HOUR);
  utimesSync(path, t, t);
}

function fakeCache(): string {
  const dir = tempDir("go-cache-");
  mkdirSync(join(dir, "ab"));
  mkdirSync(join(dir, "cd"));
  return dir;
}

test("removes entries older than the max age and keeps fresh ones", async () => {
  const dir = fakeCache();
  entry(join(dir, "ab", "old-a"), 72);
  entry(join(dir, "ab", "fresh-a"), 1);
  entry(join(dir, "cd", "old-d"), 50, true);

  const result = await trimGoCache(dir, 48 * HOUR, NOW);

  assert.equal(existsSync(join(dir, "ab", "old-a")), false);
  assert.equal(existsSync(join(dir, "cd", "old-d")), false);
  assert.equal(existsSync(join(dir, "ab", "fresh-a")), true);
  assert.equal(result.removed, 2);
  assert.equal(result.freedBytes, 11);
});

test("leaves Go's own bookkeeping files and non-hex dirs alone", async () => {
  const dir = fakeCache();
  entry(join(dir, "README"), 1000);
  entry(join(dir, "trim.txt"), 1000);
  mkdirSync(join(dir, "fuzz"));
  entry(join(dir, "fuzz", "corpus"), 1000);

  const result = await trimGoCache(dir, 48 * HOUR, NOW);

  assert.equal(result.removed, 0);
  assert.equal(existsSync(join(dir, "README")), true);
  assert.equal(existsSync(join(dir, "trim.txt")), true);
  assert.equal(existsSync(join(dir, "fuzz", "corpus")), true);
});

test("a missing cache dir is a no-op", async () => {
  const result = await trimGoCache(join(tempDir("go-cache-"), "nope"), 48 * HOUR, NOW);
  assert.deepEqual(result, { removed: 0, freedBytes: 0 });
});

test("sweepGoBuildDirs removes go-build work dirs idle past the max age and leaves the rest", async () => {
  const tmp = tempDir("go-tmp-");
  const age = (path: string, hours: number) => {
    const t = new Date(NOW - hours * HOUR);
    utimesSync(path, t, t);
  };
  mkdirSync(join(tmp, "go-build111", "b001"), { recursive: true });
  writeFileSync(join(tmp, "go-build111", "b001", "exe"), "x".repeat(10));
  age(join(tmp, "go-build111", "b001"), 5);
  age(join(tmp, "go-build111"), 5);
  // A live build: the top dir is old but a work subdir was just written.
  mkdirSync(join(tmp, "go-build222", "b007"), { recursive: true });
  age(join(tmp, "go-build222"), 5);
  mkdirSync(join(tmp, "other-old"));
  age(join(tmp, "other-old"), 5);

  const result = await sweepGoBuildDirs([tmp, tmp], HOUR, NOW);

  assert.equal(existsSync(join(tmp, "go-build111")), false);
  assert.equal(existsSync(join(tmp, "go-build222")), true);
  assert.equal(existsSync(join(tmp, "other-old")), true);
  assert.equal(result.removed, 1);
  assert.equal(result.freedBytes, 10);
});

test("sweepGoBuildDirs tolerates a missing tmp dir", async () => {
  assert.deepEqual(await sweepGoBuildDirs([join(tempDir("go-tmp-"), "nope")], HOUR, NOW), { removed: 0, freedBytes: 0 });
});
