import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveKey, titleFromBranch, statusFor } from "./events.ts";

test("deriveKey: identifier wins and is uppercased", () => {
  assert.deepEqual(deriveKey({ identifier: "eng-42" }), { key: "ENG-42", label: "ENG-42" });
});

test("deriveKey: branch normalizes to ticket key", () => {
  assert.deepEqual(deriveKey({ branch: "eng-42-auth-guard" }), { key: "ENG-42", label: "ENG-42" });
  assert.deepEqual(deriveKey({ branch: "SC-7-thing" }), { key: "SC-7", label: "SC-7" });
});

test("deriveKey: branch+pr with ticket slug still unifies on the ticket", () => {
  assert.deepEqual(deriveKey({ branch: "eng-42-x", pr: 128 }), { key: "ENG-42", label: "ENG-42" });
});

test("deriveKey: pr fallback when branch has no ticket slug", () => {
  assert.deepEqual(deriveKey({ branch: "fix/wrike-shared-users", pr: 128 }), {
    key: "pr:128",
    label: "PR #128",
  });
});

test("deriveKey: bare pr", () => {
  assert.deepEqual(deriveKey({ pr: 5 }), { key: "pr:5", label: "PR #5" });
});

test("titleFromBranch strips ticket prefix and humanizes", () => {
  assert.equal(titleFromBranch("eng-42-auth-guard"), "auth guard");
  assert.equal(titleFromBranch("fix/wrike-shared-users"), "fix wrike shared users");
});

test("statusFor maps kinds; only merged is terminal", () => {
  assert.deepEqual(statusFor("task_started"), { status: "working", terminal: false });
  assert.deepEqual(statusFor("review_started"), { status: "addressing review", terminal: false });
  assert.deepEqual(statusFor("ci_fix_started"), { status: "fixing CI", terminal: false });
  assert.deepEqual(statusFor("conflict_fix_started"), { status: "resolving conflict", terminal: false });
  assert.deepEqual(statusFor("ready_to_test"), { status: "ready to test", terminal: false });
  assert.deepEqual(statusFor("ready_to_merge"), { status: "ready to merge", terminal: false });
  assert.deepEqual(statusFor("ready_regressed"), { status: "working", terminal: false });
  assert.deepEqual(statusFor("merged"), { status: "merged", terminal: true });
});
