import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearedStateNames,
  isAfterReleaseOrphan,
  isBlocked,
  mergedIdentifierSet,
  ticketIdentifierFromBranch,
  unsatisfiedBlockers,
  type Blocker,
} from "./blocked.ts";

const blocker = (identifier: string, stateName: string, stateType = "started"): Blocker => ({
  identifier,
  stateName,
  stateType,
});

const cleared = clearedStateNames("Merged", "Deployed To Nonprod");

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

test("clearedStateNames lowercases both names and drops blanks", () => {
  assert.deepEqual([...clearedStateNames("Merged", "")].sort(), ["merged"]);
  assert.deepEqual([...clearedStateNames("Merged", "Deployed To Nonprod")].sort(), [
    "deployed to nonprod",
    "merged",
  ]);
});

test("isBlocked is false when there are no blockers", () => {
  assert.equal(isBlocked([], new Set(["ENG-1"]), cleared), false);
});

test("isBlocked is false when a blocker sits in the merged state", () => {
  assert.equal(isBlocked([blocker("ENG-4", "Merged")], new Set(), cleared), false);
});

test("isBlocked is false when a blocker moved past merged to the review state", () => {
  assert.equal(isBlocked([blocker("ENG-4", "Deployed To Nonprod")], new Set(), cleared), false);
});

test("isBlocked matches the cleared state name case-insensitively", () => {
  assert.equal(isBlocked([blocker("ENG-4", "merged")], new Set(), cleared), false);
});

test("isBlocked is false for any completed or canceled blocker, whatever the state name", () => {
  assert.equal(
    isBlocked([blocker("ENG-4", "Ready To Release", "completed")], new Set(), cleared),
    false,
  );
  assert.equal(isBlocked([blocker("ENG-5", "Done", "completed")], new Set(), cleared), false);
  assert.equal(isBlocked([blocker("ENG-6", "Canceled", "canceled")], new Set(), cleared), false);
});

test("isBlocked is true while a blocker is still short of merged", () => {
  assert.equal(isBlocked([blocker("ENG-4", "In Review")], new Set(), cleared), true);
  assert.equal(isBlocked([blocker("ENG-5", "In Progress")], new Set(), cleared), true);
  assert.equal(isBlocked([blocker("ENG-6", "Todo", "unstarted")], new Set(), cleared), true);
});

test("isBlocked still clears a blocker whose PR merged but whose ticket never moved", () => {
  assert.equal(
    isBlocked([blocker("ENG-4", "In Progress")], new Set(["ENG-4"]), cleared),
    false,
  );
  assert.equal(isBlocked([blocker("sc-9", "In Progress")], new Set(["SC-9"]), cleared), false);
});

test("isBlocked is true when any one blocker is unsatisfied", () => {
  const blockers = [blocker("ENG-4", "Merged"), blocker("ENG-5", "In Review")];
  assert.equal(isBlocked(blockers, new Set(), cleared), true);
});

test("unsatisfiedBlockers names the holdouts with their current state", () => {
  const blockers = [blocker("ENG-4", "Merged"), blocker("ENG-5", "In Review")];
  assert.equal(unsatisfiedBlockers(blockers, new Set(), cleared), "ENG-5 (In Review)");
});

test("ticketIdentifierFromBranch reads the leading identifier, uppercased", () => {
  assert.equal(ticketIdentifierFromBranch("eng-1104-do-a-thing"), "ENG-1104");
  assert.equal(ticketIdentifierFromBranch("SC-42-thing"), "SC-42");
  assert.equal(ticketIdentifierFromBranch("hotfix-login"), null);
});

test("an after-release ticket stays blocked while its parent is In Review, Merged, or has a merged PR", () => {
  assert.equal(isBlocked([blocker("ENG-4", "In Review")], new Set(), cleared, true), true);
  assert.equal(isBlocked([blocker("ENG-4", "Merged")], new Set(), cleared, true), true);
  assert.equal(isBlocked([blocker("ENG-4", "Deployed To Nonprod")], new Set(), cleared, true), true);
  assert.equal(isBlocked([blocker("ENG-4", "In Progress")], new Set(["ENG-4"]), cleared, true), true);
});

test("an after-release ticket clears once the parent is completed, canceled or a duplicate", () => {
  assert.equal(isBlocked([blocker("ENG-4", "Done", "completed")], new Set(), cleared, true), false);
  assert.equal(isBlocked([blocker("ENG-4", "Canceled", "canceled")], new Set(), cleared, true), false);
  assert.equal(isBlocked([blocker("ENG-4", "Duplicate", "duplicate")], new Set(), cleared, true), false);
});

test("an after-release ticket with no blockers is always blocked", () => {
  assert.equal(isBlocked([], new Set(), cleared, true), true);
  assert.equal(isAfterReleaseOrphan(true, []), true);
  assert.equal(isAfterReleaseOrphan(true, [blocker("ENG-4", "Done", "completed")]), false);
  assert.equal(isAfterReleaseOrphan(false, []), false);
});

test("tickets without the label behave as before", () => {
  assert.equal(isBlocked([blocker("ENG-4", "Merged")], new Set(), cleared, false), false);
  assert.equal(isBlocked([blocker("ENG-4", "In Review")], new Set(["ENG-4"]), cleared), false);
});

test("unsatisfiedBlockers says an after-release holdout is waiting for release", () => {
  assert.equal(
    unsatisfiedBlockers([blocker("ENG-1", "In Review")], new Set(), cleared, true),
    "ENG-1 (In Review, waiting for release)",
  );
});
