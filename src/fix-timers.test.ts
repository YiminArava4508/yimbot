import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "./test-temp.ts";
import { fixTimersFilePath, loadFixSeenAt, parseFixSeenAt, saveFixSeenAt } from "./fix-timers.ts";

function withTempEventsLog<T>(fn: (dir: string) => T): T {
  const prevEnv = process.env.EVENTS_LOG;
  try {
    const dir = tempDir("yimbot-fix-timers-");
    process.env.EVENTS_LOG = join(dir, "events.jsonl");
    return fn(dir);
  } finally {
    if (prevEnv === undefined) delete process.env.EVENTS_LOG;
    else process.env.EVENTS_LOG = prevEnv;
  }
}

test("fixTimersFilePath sits next to the events log", () => {
  withTempEventsLog((dir) => {
    assert.equal(dirname(fixTimersFilePath()), dir);
    assert.equal(fixTimersFilePath(), join(dir, "fix-timers.json"));
  });
});

test("parseFixSeenAt tolerates junk and keeps only numeric entries", () => {
  assert.deepEqual(parseFixSeenAt("not json"), new Map());
  assert.deepEqual(parseFixSeenAt("[1,2]"), new Map());
  assert.deepEqual(
    parseFixSeenAt('{"6000:ci":1789160127459,"5999:fix":"soon","bad":null}'),
    new Map([["6000:ci", 1789160127459]]),
  );
});

test("saveFixSeenAt then loadFixSeenAt round-trips the timers", () => {
  withTempEventsLog(() => {
    saveFixSeenAt(new Map([["6000:ci", 1789160127459], ["5999:conflict", 5]]));
    assert.deepEqual(JSON.parse(readFileSync(fixTimersFilePath(), "utf8")), {
      "6000:ci": 1789160127459,
      "5999:conflict": 5,
    });
    assert.deepEqual(loadFixSeenAt(), new Map([["6000:ci", 1789160127459], ["5999:conflict", 5]]));
  });
});

test("loadFixSeenAt is empty when the file is missing or corrupt", () => {
  withTempEventsLog(() => {
    assert.deepEqual(loadFixSeenAt(), new Map());
    writeFileSync(fixTimersFilePath(), "{{{");
    assert.deepEqual(loadFixSeenAt(), new Map());
  });
});

test("saveFixSeenAt with an empty map writes an empty object", () => {
  withTempEventsLog(() => {
    saveFixSeenAt(new Map([["6000:ci", 1]]));
    saveFixSeenAt(new Map());
    assert.equal(readFileSync(fixTimersFilePath(), "utf8"), "{}\n");
  });
});
