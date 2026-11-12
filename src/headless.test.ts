// src/headless.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./test-temp.ts";
import { runHeadless, withoutApiKey } from "./headless.ts";
import { agentFromEnv, headlessCommand } from "./agent.ts";

// A stand-in `claude` on PATH, so a test can see which channel the prompt
// arrived on and what argv it was called with.
function onPath(body: string, name = "claude"): void {
  const dir = tempDir("headless-");
  const bin = join(dir, name);
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

test("runHeadless runs the child on the env it is given", async () => {
  onPath('printf "%s" "${ANTHROPIC_API_KEY-unset}"; cat >/dev/null');
  process.env.ANTHROPIC_API_KEY = "sk-bad";
  try {
    assert.equal(await runHeadless("", process.cwd(), 5000, "claude")("hi"), "sk-bad");
    assert.equal(await runHeadless("", process.cwd(), 5000, "claude", withoutApiKey())("hi"), "unset");
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test("headlessCommand keeps the claude -p shape", () => {
  assert.deepEqual(headlessCommand("claude", "opus"), { bin: "claude", args: ["-p", "--model", "opus"] });
  assert.deepEqual(headlessCommand("claude", ""), { bin: "claude", args: ["-p"] });
});

test("headlessCommand builds a read-only codex exec reading the prompt from stdin", () => {
  assert.deepEqual(headlessCommand("codex", "gpt-5"), {
    bin: "codex",
    args: ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "-m", "gpt-5", "-"],
  });
  assert.deepEqual(headlessCommand("codex", "").args.slice(-1), ["-"]);
});

test("agentFromEnv defaults to claude and rejects an unknown agent", () => {
  assert.equal(agentFromEnv({}), "claude");
  assert.equal(agentFromEnv({ AGENT: "codex" }), "codex");
  assert.throws(() => agentFromEnv({ AGENT: "gemini" }), /AGENT must be one of claude, codex/);
});

test("runHeadless runs codex exec when the agent is codex", async () => {
  onPath('printf "argv:%s " "$@"; cat', "codex");
  const out = await runHeadless("gpt-5", process.cwd(), 5000, "codex")("map this");
  assert.equal(
    out,
    "argv:exec argv:--skip-git-repo-check argv:--sandbox argv:read-only argv:-m argv:gpt-5 argv:- map this",
  );
});

test("runHeadless names codex in its failure and timeout errors", async () => {
  onPath('echo "no auth" >&2; exit 2', "codex");
  await assert.rejects(runHeadless("", process.cwd(), 5000, "codex")("hi"), /codex exited 2: no auth/);
  onPath("sleep 5", "codex");
  await assert.rejects(runHeadless("", process.cwd(), 50, "codex")("hi"), /codex timed out after 50ms/);
});
