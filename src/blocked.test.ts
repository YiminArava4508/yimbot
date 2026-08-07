import assert from "node:assert/strict";
import { test } from "node:test";
import { isBlocked, mergedIdentifierSet } from "./blocked.ts";

test("mergedIdentifierSet parses identifiers from branch names, uppercased and deduped", () => {
  const set = mergedIdentifierSet([
    { number: 1, headRefName: "eng-42-fix-login" },
    { number: 2, headRefName: "ENG-42-followup" },
    { number: 3, headRefName: "sc-7-thing" },
    { number: 4, headRefName: "no-identifier-here" },
    { number: 5, headRefName: "release" },
  ]);
  assert.deepEqual([...set].sort(), ["ENG-42", "SC-7"]);
});

test("isBlocked is false when there are no blockers", () => {
  assert.equal(isBlocked([], new Set(["ENG-1"])), false);
});

test("isBlocked is false when every blocker is merged (case-insensitive)", () => {
  assert.equal(isBlocked(["ENG-4", "sc-9"], new Set(["ENG-4", "SC-9"])), false);
});

test("isBlocked is true when any blocker is unmerged", () => {
  assert.equal(isBlocked(["ENG-4", "ENG-5"], new Set(["ENG-4"])), true);
});
