import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDependencyPrompt,
  candidateLines,
  DEPENDENCY_COMMENT_MARKER,
  normalizeDescription,
  parseDependencies,
  renderDependencyComment,
  scanDescription,
} from "./dependency.ts";

test("normalizeDescription collapses markdown links to their label", () => {
  const raw = "See [ENG-1197](https://linear.app/x/issue/ENG-1197/terraform-deploys-failing) now.";
  assert.equal(normalizeDescription(raw), "See ENG-1197 now.");
});

test("normalizeDescription handles Linear's angle-bracket link form", () => {
  const raw = "Migrated from [sc-8387](<https://app.shortcut.com/matthews-1/story/8387>) today";
  assert.equal(normalizeDescription(raw), "Migrated from sc-8387 today");
});

test("normalizeDescription removes slug words that would otherwise match keywords", () => {
  const raw = "Ref [ENG-9](https://linear.app/x/issue/ENG-9/blocked-on-something).";
  const normalized = normalizeDescription(raw);
  assert.equal(candidateLines(raw).length, 1, "raw slug falsely matches 'blocked'");
  assert.equal(candidateLines(normalized).length, 0);
});

test("candidateLines ignores a reference list with no dependency keyword", () => {
  const line = "**Reference tickets/files:** ENG-221, ENG-220, ENG-1017, ENG-253 (field set to reuse).";
  assert.deepEqual(candidateLines(line), []);
});

test("candidateLines ignores a follow-up mention", () => {
  assert.deepEqual(candidateLines("Follow-up to ENG-1434."), []);
});

test("candidateLines ignores a keyword with no identifier", () => {
  assert.deepEqual(candidateLines("This is blocked on a design decision."), []);
});

test("candidateLines keeps an explicit blocked-by line", () => {
  const line = "This is blocked by ENG-1319 and must wait.";
  assert.deepEqual(candidateLines(line), [line]);
});

test("candidateLines keeps a reverse-direction line so the model can reject it", () => {
  const line = "* Blocks ENG-1132: the trigger must be repointed before the HR table is dropped.";
  assert.deepEqual(candidateLines(line), [line]);
});

test("buildDependencyPrompt names the ticket, the lines, and the JSON contract", () => {
  const p = buildDependencyPrompt("ENG-1320", ["blocked by ENG-1319"]);
  assert.ok(p.includes("ENG-1320"));
  assert.ok(p.includes("blocked by ENG-1319"));
  assert.ok(p.includes('"blockedBy"'));
});

test("parseDependencies extracts a wrapped JSON object", () => {
  const out = 'sure:\n{"blockedBy":["ENG-1319"]}\ndone';
  assert.deepEqual(parseDependencies(out, "ENG-1320", "blocked by ENG-1319"), ["ENG-1319"]);
});

test("parseDependencies drops an identifier absent from the description", () => {
  const out = '{"blockedBy":["ENG-999"]}';
  assert.deepEqual(parseDependencies(out, "ENG-1320", "blocked by ENG-1319"), []);
});

test("parseDependencies requires a whole-identifier match, not a substring", () => {
  const out = '{"blockedBy":["ENG-13"]}';
  assert.deepEqual(parseDependencies(out, "ENG-1320", "blocked by ENG-1319"), []);
});

test("parseDependencies drops the ticket's own identifier", () => {
  const out = '{"blockedBy":["ENG-1320","ENG-1319"]}';
  assert.deepEqual(parseDependencies(out, "ENG-1320", "ENG-1320 blocked by ENG-1319"), ["ENG-1319"]);
});

test("parseDependencies dedupes repeats", () => {
  const out = '{"blockedBy":["ENG-1319","eng-1319"]}';
  assert.deepEqual(parseDependencies(out, "ENG-1320", "blocked by ENG-1319"), ["ENG-1319"]);
});

test("parseDependencies returns empty above the cap of 5", () => {
  const ids = ["ENG-1", "ENG-2", "ENG-3", "ENG-4", "ENG-5", "ENG-6"];
  const out = JSON.stringify({ blockedBy: ids });
  assert.deepEqual(parseDependencies(out, "ENG-9", ids.join(" ")), []);
});

test("parseDependencies allows exactly the cap", () => {
  const ids = ["ENG-1", "ENG-2", "ENG-3", "ENG-4", "ENG-5"];
  const out = JSON.stringify({ blockedBy: ids });
  assert.deepEqual(parseDependencies(out, "ENG-9", ids.join(" ")), ids);
});

test("parseDependencies returns empty on garbage and on a wrong shape", () => {
  assert.deepEqual(parseDependencies("no json here", "ENG-9", "ENG-1"), []);
  assert.deepEqual(parseDependencies('{"blockedBy":"ENG-1"}', "ENG-9", "ENG-1"), []);
  assert.deepEqual(parseDependencies("{oops", "ENG-9", "ENG-1"), []);
});

test("scanDescription short-circuits without calling the model when nothing qualifies", async () => {
  let called = false;
  const run = async () => {
    called = true;
    return '{"blockedBy":["ENG-1319"]}';
  };
  const found = await scanDescription(run, "ENG-1320", "Follow-up to ENG-1434.");
  assert.equal(called, false);
  assert.deepEqual(found, []);
});

test("scanDescription normalizes before prefiltering and guarding", async () => {
  const desc = "Must land after [ENG-1319](https://linear.app/x/issue/ENG-1319/stnl-data-model).";
  const run = async (prompt: string) => {
    assert.ok(!prompt.includes("https://"), "model must see normalized text");
    return '{"blockedBy":["ENG-1319"]}';
  };
  assert.deepEqual(await scanDescription(run, "ENG-1320", desc), ["ENG-1319"]);
});

test("renderDependencyComment carries the marker, the blockers, and the source line", () => {
  const body = renderDependencyComment("ENG-1320", ["ENG-1319"], ["Must land after ENG-1319."]);
  assert.ok(body.includes(DEPENDENCY_COMMENT_MARKER));
  assert.ok(body.includes("ENG-1320"));
  assert.ok(body.includes("ENG-1319"));
  assert.ok(body.includes("> Must land after ENG-1319."));
});
