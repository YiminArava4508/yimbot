import assert from "node:assert/strict";
import { test } from "node:test";
import { envOr } from "./env.ts";

const NAME = "YIMBOT_TEST_VAR";

test("envOr returns fallback when unset", () => {
  delete process.env[NAME];
  assert.equal(envOr(NAME, "fallback"), "fallback");
});

test("envOr returns fallback when empty string", () => {
  process.env[NAME] = "";
  assert.equal(envOr(NAME, "fallback"), "fallback");
  delete process.env[NAME];
});

test("envOr returns fallback when whitespace-only", () => {
  process.env[NAME] = "   ";
  assert.equal(envOr(NAME, "fallback"), "fallback");
  delete process.env[NAME];
});

test("envOr returns the trimmed value when set", () => {
  process.env[NAME] = "  real-value  ";
  assert.equal(envOr(NAME, "fallback"), "real-value");
  delete process.env[NAME];
});
