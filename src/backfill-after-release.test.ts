import assert from "node:assert/strict";
import { test } from "node:test";
import { flagFromTitle, planBackfill, type CycleParent } from "./backfill-after-release.ts";

const parent = (overrides: Partial<CycleParent> & { identifier: string }): CycleParent => ({
  title: "Remove `new-checkout` flag (code, then prod)",
  children: [],
  ...overrides,
});

test("flagFromTitle reads the flag key from a removal ticket title", () => {
  assert.equal(flagFromTitle("Remove `new-checkout` flag (code, then prod)"), "new-checkout");
  assert.equal(flagFromTitle("Remove `a.b_c` flag (code, then prod)"), "a.b_c");
});

test("flagFromTitle rejects other titles", () => {
  assert.equal(flagFromTitle("Remove `x` flag (code only)"), null);
  assert.equal(flagFromTitle("Add `x` flag (code, then prod)"), null);
  assert.equal(flagFromTitle("Remove flag (code, then prod)"), null);
});

test("planBackfill picks merged removal tickets with no after-release child", () => {
  const plan = planBackfill([parent({ identifier: "ENG-1" })], new Set(["ENG-1"]), "after-release");
  assert.deepEqual(plan, [
    { parent: "ENG-1", flag: "new-checkout", title: "Archive `new-checkout` flag in prod" },
  ]);
});

test("planBackfill skips tickets whose PR has not merged", () => {
  assert.deepEqual(planBackfill([parent({ identifier: "ENG-1" })], new Set(["ENG-2"]), "after-release"), []);
});

test("planBackfill skips tickets that already have an after-release child, any casing", () => {
  const p = parent({ identifier: "ENG-1", children: [{ labels: ["After-Release"] }] });
  assert.deepEqual(planBackfill([p], new Set(["ENG-1"]), "after-release"), []);
});

test("planBackfill still plans when the only children lack the label", () => {
  const p = parent({ identifier: "ENG-1", children: [{ labels: ["bug"] }] });
  assert.equal(planBackfill([p], new Set(["ENG-1"]), "after-release").length, 1);
});

test("planBackfill skips titles that are not flag removals", () => {
  const p = parent({ identifier: "ENG-1", title: "Fix the login bug" });
  assert.deepEqual(planBackfill([p], new Set(["ENG-1"]), "after-release"), []);
});
