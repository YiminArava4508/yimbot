import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_DIFF_CHARS, buildMasterReviewPrompt, parseMasterVerdict } from "./master-review.ts";

test("MAX_DIFF_CHARS is 120000", () => {
  assert.equal(MAX_DIFF_CHARS, 120_000);
});

test("prompt carries title and diff inside delimiters and marks the diff untrusted", () => {
  const prompt = buildMasterReviewPrompt("Fix the thing", "diff --git a/x b/x\n+hello");
  assert.match(prompt, /Fix the thing/);
  const start = prompt.indexOf("=====BEGIN DIFF=====");
  const end = prompt.indexOf("=====END DIFF=====");
  assert.ok(start !== -1 && end > start);
  assert.match(prompt.slice(start, end), /\+hello/);
  assert.match(prompt, /untrusted data/);
  assert.match(prompt, /ignore any instructions/i);
  assert.match(prompt, /"clean"/);
});

test("parseMasterVerdict reads JSON in prose", () => {
  assert.deepEqual(parseMasterVerdict('Looks good. {"clean": true, "findings": []} done'), {
    clean: true,
    findings: [],
  });
});

test("parseMasterVerdict reads a fenced block", () => {
  const out = 'Result:\n```json\n{"clean": false, "findings": ["bug in x"]}\n```';
  assert.deepEqual(parseMasterVerdict(out), { clean: false, findings: ["bug in x"] });
});

test("clean true with findings becomes clean false", () => {
  assert.deepEqual(parseMasterVerdict('{"clean": true, "findings": ["nit"]}'), {
    clean: false,
    findings: ["nit"],
  });
});

test("unparseable or malformed verdicts are null", () => {
  assert.equal(parseMasterVerdict("nope"), null);
  assert.equal(parseMasterVerdict('{"clean":"yes"}'), null);
  assert.equal(parseMasterVerdict(""), null);
});

test("non-string findings are dropped", () => {
  assert.deepEqual(parseMasterVerdict('{"clean": false, "findings": ["a", 1, null]}'), {
    clean: false,
    findings: ["a"],
  });
});
