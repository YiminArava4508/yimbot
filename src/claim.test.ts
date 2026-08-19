import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMaxEstimate, selectNextClaim } from "./claim.ts";
import { parseLabelFilter } from "./labels.ts";
import type { CycleTodoIssue } from "./linear-api.ts";

function todo(overrides: Partial<CycleTodoIssue> & { id: string }): CycleTodoIssue {
  return {
    identifier: `ENG-${overrides.id}`,
    title: `Issue ${overrides.id}`,
    description: "",
    priority: 0,
    sortOrder: 0,
    estimate: 2,
    labels: [],
    blockedBy: [],
    ...overrides,
  };
}

const riskLabels = ["migration", "infra", "security", "breaking"];

const opts = (merged: Set<string> | null = null, requireEstimate = false) => ({
  riskLabels,
  merged,
  labelFilter: null,
  requireEstimate,
  maxEstimate: null,
});

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

test("selectNextClaim always skips zero-point container tickets", () => {
  const picked = selectNextClaim(
    [todo({ id: "1", estimate: 0 }), todo({ id: "2", estimate: 3 })],
    opts(),
  );
  assert.equal(picked?.identifier, "ENG-2");
});

test("selectNextClaim skips unestimated tickets when requireEstimate is on", () => {
  const picked = selectNextClaim(
    [todo({ id: "1", estimate: null }), todo({ id: "2", estimate: 3 })],
    opts(null, true),
  );
  assert.equal(picked?.identifier, "ENG-2");
});

test("selectNextClaim skips 0-point container tickets even when requireEstimate is on", () => {
  const picked = selectNextClaim(
    [todo({ id: "1", estimate: 0 }), todo({ id: "2", estimate: 3 })],
    opts(null, true),
  );
  assert.equal(picked?.identifier, "ENG-2");
});

test("selectNextClaim keeps unestimated tickets when requireEstimate is off", () => {
  const picked = selectNextClaim([todo({ id: "1", estimate: null })], opts());
  assert.equal(picked?.identifier, "ENG-1");
});

test("selectNextClaim skips tickets estimated above maxEstimate", () => {
  const picked = selectNextClaim(
    [todo({ id: "big", priority: 1, estimate: 5 }), todo({ id: "small", priority: 2, estimate: 2 })],
    { ...opts(), maxEstimate: 3 },
  );
  assert.equal(picked?.id, "small");
});

test("selectNextClaim treats maxEstimate as inclusive", () => {
  const picked = selectNextClaim([todo({ id: "edge", estimate: 3 })], { ...opts(), maxEstimate: 3 });
  assert.equal(picked?.id, "edge");
});

test("selectNextClaim ignores estimates when maxEstimate is null", () => {
  const picked = selectNextClaim([todo({ id: "big", estimate: 8 })], opts());
  assert.equal(picked?.id, "big");
});

test("selectNextClaim keeps unestimated tickets under a maxEstimate cap", () => {
  const picked = selectNextClaim([todo({ id: "unsized", estimate: null })], {
    ...opts(),
    maxEstimate: 2,
  });
  assert.equal(picked?.id, "unsized");
});

test("parseMaxEstimate reads a positive integer and treats everything else as no cap", () => {
  assert.equal(parseMaxEstimate("3"), 3);
  assert.equal(parseMaxEstimate(" 8 "), 8);
  assert.equal(parseMaxEstimate(""), null);
  assert.equal(parseMaxEstimate(undefined), null);
  assert.equal(parseMaxEstimate("0"), null);
  assert.equal(parseMaxEstimate("-2"), null);
  assert.equal(parseMaxEstimate("abc"), null);
  assert.equal(parseMaxEstimate("2.5"), null);
});
