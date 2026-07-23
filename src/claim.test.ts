import assert from "node:assert/strict";
import { test } from "node:test";
import { selectNextClaim } from "./claim.ts";
import type { CycleTodoIssue } from "./linear-api.ts";

function todo(overrides: Partial<CycleTodoIssue> & { id: string }): CycleTodoIssue {
  return {
    identifier: `ENG-${overrides.id}`,
    title: `Issue ${overrides.id}`,
    priority: 0,
    sortOrder: 0,
    labels: [],
    ...overrides,
  };
}

const riskLabels = ["migration", "infra", "security", "breaking"];

test("selectNextClaim picks the highest Linear priority (Urgent=1 before High=2)", () => {
  const picked = selectNextClaim(
    [todo({ id: "a", priority: 2 }), todo({ id: "b", priority: 1 })],
    { riskLabels },
  );
  assert.equal(picked?.id, "b");
});

test("selectNextClaim treats priority 0 (None) as lowest, not highest", () => {
  const picked = selectNextClaim(
    [todo({ id: "none", priority: 0 }), todo({ id: "low", priority: 4 })],
    { riskLabels },
  );
  assert.equal(picked?.id, "low");
});

test("selectNextClaim breaks priority ties by sortOrder ascending", () => {
  const picked = selectNextClaim(
    [
      todo({ id: "later", priority: 2, sortOrder: 10 }),
      todo({ id: "earlier", priority: 2, sortOrder: 3 }),
    ],
    { riskLabels },
  );
  assert.equal(picked?.id, "earlier");
});

test("selectNextClaim drops risk-labeled tickets (case-insensitive)", () => {
  const picked = selectNextClaim(
    [
      todo({ id: "risky", priority: 1, labels: ["Migration"] }),
      todo({ id: "safe", priority: 3 }),
    ],
    { riskLabels },
  );
  assert.equal(picked?.id, "safe");
});

test("selectNextClaim returns null when every candidate is filtered out", () => {
  const picked = selectNextClaim([todo({ id: "risky", labels: ["security"] })], { riskLabels });
  assert.equal(picked, null);
});

test("selectNextClaim returns null for an empty list", () => {
  assert.equal(selectNextClaim([], { riskLabels }), null);
});
