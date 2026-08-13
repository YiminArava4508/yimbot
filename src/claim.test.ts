import assert from "node:assert/strict";
import { test } from "node:test";
import { selectNextClaim } from "./claim.ts";
import { parseLabelFilter } from "./labels.ts";
import type { CycleTodoIssue } from "./linear-api.ts";

function todo(overrides: Partial<CycleTodoIssue> & { id: string }): CycleTodoIssue {
  return {
    identifier: `ENG-${overrides.id}`,
    title: `Issue ${overrides.id}`,
    description: "",
    priority: 0,
    sortOrder: 0,
    labels: [],
    blockedBy: [],
    ...overrides,
  };
}

const riskLabels = ["migration", "infra", "security", "breaking"];

const opts = (merged: Set<string> | null = null) => ({ riskLabels, merged, labelFilter: null });

test("selectNextClaim picks the highest Linear priority (Urgent=1 before High=2)", () => {
  const picked = selectNextClaim(
    [todo({ id: "a", priority: 2 }), todo({ id: "b", priority: 1 })],
    opts(),
  );
  assert.equal(picked?.id, "b");
});

test("selectNextClaim treats priority 0 (None) as lowest, not highest", () => {
  const picked = selectNextClaim(
    [todo({ id: "none", priority: 0 }), todo({ id: "low", priority: 4 })],
    opts(),
  );
  assert.equal(picked?.id, "low");
});

test("selectNextClaim breaks priority ties by sortOrder ascending", () => {
  const picked = selectNextClaim(
    [
      todo({ id: "later", priority: 2, sortOrder: 10 }),
      todo({ id: "earlier", priority: 2, sortOrder: 3 }),
    ],
    opts(),
  );
  assert.equal(picked?.id, "earlier");
});

test("selectNextClaim drops risk-labeled tickets (case-insensitive)", () => {
  const picked = selectNextClaim(
    [
      todo({ id: "risky", priority: 1, labels: ["Migration"] }),
      todo({ id: "safe", priority: 3 }),
    ],
    opts(),
  );
  assert.equal(picked?.id, "safe");
});

test("selectNextClaim returns null when every candidate is filtered out", () => {
  const picked = selectNextClaim([todo({ id: "risky", labels: ["security"] })], opts());
  assert.equal(picked, null);
});

test("selectNextClaim returns null for an empty list", () => {
  assert.equal(selectNextClaim([], opts()), null);
});

test("selectNextClaim defers a todo whose blocker is unmerged", () => {
  const picked = selectNextClaim(
    [todo({ id: "blocked", priority: 1, blockedBy: ["ENG-4"] })],
    opts(new Set()),
  );
  assert.equal(picked, null);
});

test("selectNextClaim claims a todo whose blockers are all merged", () => {
  const picked = selectNextClaim(
    [todo({ id: "ok", priority: 1, blockedBy: ["ENG-4"] })],
    opts(new Set(["ENG-4"])),
  );
  assert.equal(picked?.id, "ok");
});

test("selectNextClaim prefers the unblocked lower-priority todo over a blocked urgent one", () => {
  const picked = selectNextClaim(
    [
      todo({ id: "urgent-blocked", priority: 1, blockedBy: ["ENG-4"] }),
      todo({ id: "low-free", priority: 3 }),
    ],
    opts(new Set()),
  );
  assert.equal(picked?.id, "low-free");
});

test("selectNextClaim ignores blockers when merged is null (gh unavailable)", () => {
  const picked = selectNextClaim(
    [todo({ id: "blocked", priority: 1, blockedBy: ["ENG-4"] })],
    opts(null),
  );
  assert.equal(picked?.id, "blocked");
});

test("selectNextClaim skips labelled todos under a negated filter", () => {
  const picked = selectNextClaim(
    [todo({ id: "a", priority: 1, labels: ["bot"] }), todo({ id: "b", priority: 2 })],
    { ...opts(), labelFilter: parseLabelFilter("!bot") },
  );
  assert.equal(picked?.id, "b");
});

test("selectNextClaim takes only labelled todos under an include filter", () => {
  const picked = selectNextClaim(
    [todo({ id: "a", priority: 1 }), todo({ id: "b", priority: 2, labels: ["bot"] })],
    { ...opts(), labelFilter: parseLabelFilter("bot") },
  );
  assert.equal(picked?.id, "b");
});

test("selectNextClaim still drops risk labels under an include filter", () => {
  const picked = selectNextClaim(
    [todo({ id: "a", priority: 1, labels: ["bot", "migration"] })],
    { ...opts(), labelFilter: parseLabelFilter("bot") },
  );
  assert.equal(picked, null);
});
