import assert from "node:assert/strict";
import { test } from "node:test";
import { type CheckResult, needsSetup, PREREQUISITES, setupMode } from "./setup-core.ts";

const required = PREREQUISITES.filter((pr) => pr.severity === "required");
const recommended = PREREQUISITES.filter((pr) => pr.severity === "recommended");

const allOk = async (): Promise<CheckResult[]> => required.map((pr) => ({ pr, ok: true }));
const validEnv = { LINEAR_API_KEY: "lin_api_x", CODEBASE_PATH: "/repo" };

test("needsSetup reports a blank LINEAR_API_KEY", async () => {
  const r = await needsSetup(
    { ...validEnv, LINEAR_API_KEY: "  " },
    { checkRequired: allOk, isGitRepo: () => true },
  );
  assert.equal(r.needed, true);
  assert.ok(r.reasons.some((x) => x.includes("LINEAR_API_KEY")));
});

test("needsSetup reports an unset CODEBASE_PATH", async () => {
  const r = await needsSetup(
    { LINEAR_API_KEY: "k" },
    { checkRequired: allOk, isGitRepo: () => true },
  );
  assert.equal(r.needed, true);
  assert.ok(r.reasons.some((x) => x.includes("CODEBASE_PATH")));
});

test("needsSetup reports a CODEBASE_PATH that is not a git repo", async () => {
  const r = await needsSetup(validEnv, { checkRequired: allOk, isGitRepo: () => false });
  assert.equal(r.needed, true);
  assert.ok(r.reasons.some((x) => x.includes("CODEBASE_PATH")));
});

test("needsSetup reports one reason per failing required check, naming its label", async () => {
  const failing = [required[0], required[2]];
  const r = await needsSetup(validEnv, {
    checkRequired: async () => failing.map((pr) => ({ pr, ok: false })),
    isGitRepo: () => true,
  });
  assert.equal(r.needed, true);
  assert.equal(r.reasons.length, 2);
  for (const pr of failing) assert.ok(r.reasons.some((x) => x.includes(pr.label)));
});

test("needsSetup is false when everything is in place", async () => {
  const r = await needsSetup(validEnv, { checkRequired: allOk, isGitRepo: () => true });
  assert.deepEqual(r, { needed: false, reasons: [] });
});

test("a failing recommended check alone never sets needed", async () => {
  const r = await needsSetup(validEnv, {
    checkRequired: async () => recommended.map((pr) => ({ pr, ok: false })),
    isGitRepo: () => true,
  });
  assert.deepEqual(r, { needed: false, reasons: [] });
});

test("setupMode is none when setup is not needed, even without a TTY", () => {
  assert.equal(setupMode({ isTTY: true, term: "xterm-256color", needed: false }), "none");
  assert.equal(setupMode({ isTTY: false, term: undefined, needed: false }), "none");
});

test("setupMode falls back to the CLI prompts without a TTY", () => {
  assert.equal(setupMode({ isTTY: false, term: "xterm-256color", needed: true }), "cli");
});

test("setupMode falls back to the CLI prompts on a dumb terminal", () => {
  assert.equal(setupMode({ isTTY: true, term: "dumb", needed: true }), "cli");
});

test("setupMode opens the TUI wizard on a usable terminal", () => {
  assert.equal(setupMode({ isTTY: true, term: "xterm-256color", needed: true }), "tui");
  assert.equal(setupMode({ isTTY: true, term: undefined, needed: true }), "tui");
});
