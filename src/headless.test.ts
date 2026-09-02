// src/headless.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHeadless } from "./headless.ts";

// A stand-in `claude` on PATH, so a test can see which channel the prompt
// arrived on and what argv it was called with.
function onPath(body: string): void {
  const dir = mkdtempSync(join(tmpdir(), "headless-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
}

test("runHeadless hands the prompt over on stdin and returns stdout", async () => {
  onPath('printf "argv:%s " "$@"; cat');
  const out = await runHeadless("opus", process.cwd())("map this");
  assert.equal(out, "argv:-p argv:--model argv:opus map this");
});

test("runHeadless carries a prompt far past a single argv entry", async () => {
  onPath("wc -c");
  const prompt = "x".repeat(200_000);
  assert.equal((await runHeadless("", process.cwd())(prompt)).trim(), String(prompt.length));
});

test("runHeadless rejects with what claude printed when it exits nonzero", async () => {
  onPath('echo "not logged in" >&2; exit 3');
  await assert.rejects(runHeadless("", process.cwd())("hi"), /not logged in/);
});

test("runHeadless says so when it kills a call that overran its timeout", async () => {
  onPath("sleep 5");
  await assert.rejects(runHeadless("", process.cwd(), 50)("hi"), /timed out after 50ms/);
});
