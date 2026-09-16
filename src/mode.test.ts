import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./test-temp.ts";
import { modeFilePath, readMode, toggleMode, writeMode } from "./mode.ts";

function withTempLog(fn: (dir: string) => void): void {
  const dir = tempDir("yimbot-mode-");
  const prev = process.env.EVENTS_LOG;
  process.env.EVENTS_LOG = join(dir, "events.jsonl");
  try {
    fn(dir);
  } finally {
    if (prev === undefined) delete process.env.EVENTS_LOG;
    else process.env.EVENTS_LOG = prev;
  }
}

test("modeFilePath lives next to the events log", () => {
  withTempLog((dir) => {
    assert.equal(modeFilePath(), join(dir, "mode"));
  });
});

test("readMode defaults to supervised when the file is missing", () => {
  withTempLog(() => {
    assert.equal(readMode(), "supervised");
  });
});

test("writeMode round-trips through readMode", () => {
  withTempLog(() => {
    writeMode("autonomous");
    assert.equal(readMode(), "autonomous");
    writeMode("supervised");
    assert.equal(readMode(), "supervised");
  });
});

test("readMode treats garbage or whitespace as supervised", () => {
  withTempLog(() => {
    writeFileSync(modeFilePath(), "yolo\n");
    assert.equal(readMode(), "supervised");
    writeFileSync(modeFilePath(), "  autonomous \n");
    assert.equal(readMode(), "autonomous");
  });
});

test("toggleMode flips, persists, and returns the new mode", () => {
  withTempLog(() => {
    assert.equal(toggleMode(), "autonomous");
    assert.equal(readFileSync(modeFilePath(), "utf8").trim(), "autonomous");
    assert.equal(toggleMode(), "supervised");
    assert.equal(readMode(), "supervised");
  });
});
