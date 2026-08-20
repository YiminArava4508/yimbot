import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRefineEnabled, refineEnvDefault, refineToggleFilePath, writeRefineEnabled } from "./refine-toggle.ts";

function withTempLog(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "yimbot-refine-toggle-"));
  const prev = process.env.EVENTS_LOG;
  process.env.EVENTS_LOG = join(dir, "events.jsonl");
  try {
    fn(dir);
  } finally {
    if (prev === undefined) delete process.env.EVENTS_LOG;
    else process.env.EVENTS_LOG = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("refineToggleFilePath lives next to the events log", () => {
  withTempLog((dir) => {
    assert.equal(refineToggleFilePath(), join(dir, "refine"));
  });
});

test("readRefineEnabled falls back to the default when the file is missing", () => {
  withTempLog(() => {
    assert.equal(readRefineEnabled(true), true);
    assert.equal(readRefineEnabled(false), false);
  });
});

test("writeRefineEnabled round-trips through readRefineEnabled", () => {
  withTempLog(() => {
    writeRefineEnabled(false);
    assert.equal(readRefineEnabled(true), false);
    writeRefineEnabled(true);
    assert.equal(readRefineEnabled(false), true);
  });
});

test("readRefineEnabled treats garbage or whitespace as the default", () => {
  withTempLog(() => {
    writeFileSync(refineToggleFilePath(), "yolo\n");
    assert.equal(readRefineEnabled(true), true);
    writeFileSync(refineToggleFilePath(), "  off \n");
    assert.equal(readRefineEnabled(true), false);
  });
});

test("refineEnvDefault mirrors AUTO_REFINE parsing (default on)", () => {
  assert.equal(refineEnvDefault({}), true);
  assert.equal(refineEnvDefault({ AUTO_REFINE: "true" }), true);
  assert.equal(refineEnvDefault({ AUTO_REFINE: "false" }), false);
  assert.equal(refineEnvDefault({ AUTO_REFINE: "OFF" }), false);
  assert.equal(refineEnvDefault({ AUTO_REFINE: "0" }), false);
});
