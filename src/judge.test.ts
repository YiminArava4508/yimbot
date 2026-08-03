import assert from "node:assert/strict";
import { test } from "node:test";
import type { AC } from "./acceptance.ts";
import { buildJudgePrompt, judgeAcceptance, parseJudgment } from "./judge.ts";

test("parseJudgment extracts a wrapped JSON object and validates arrays", () => {
  const out = 'here you go:\n{"satisfied":["pdf-1","pdf-2"],"skipped":[{"id":"excel-13","reason":"manual"}]}\nthanks';
  assert.deepEqual(parseJudgment(out), {
    satisfied: ["pdf-1", "pdf-2"],
    skipped: [{ id: "excel-13", reason: "manual" }],
  });
});

test("parseJudgment returns empty judgment on garbage", () => {
  assert.deepEqual(parseJudgment("no json here"), { satisfied: [], skipped: [] });
});

test("judgeAcceptance short-circuits on empty open set", async () => {
  let called = false;
  const run = async () => {
    called = true;
    return "{}";
  };
  const j = await judgeAcceptance(run, []);
  assert.equal(called, false);
  assert.deepEqual(j, { satisfied: [], skipped: [] });
});

test("buildJudgePrompt lists the open AC ids", () => {
  const open: AC[] = [{ id: "pdf-1", section: "pdf", text: "Upload button", status: "open" }];
  const p = buildJudgePrompt(open);
  assert.ok(p.includes("pdf-1"));
  assert.ok(p.includes("Upload button"));
});
