import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { trimGoCache } from "./go-cache.ts";
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
