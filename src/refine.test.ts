import assert from "node:assert/strict";
import { test } from "node:test";
import { freshRefineState, refineOnce, refineSessionName, type RefineDeps, type RefineIssue } from "./refine.ts";
import { parseLabelFilter } from "./labels.ts";

function issue(identifier: string, labels: string[] = []): RefineIssue {
  return { id: identifier, identifier, title: `title ${identifier}`, labels };
}

function makeDeps(overrides: Partial<RefineDeps> = {}): RefineDeps & {
  spawned: string[]; killed: string[]; refined: string[];
} {
  const spawned: string[] = [];
  const killed: string[] = [];
  const refined: string[] = [];
  return {
    autoRefine: true,
    maxRefining: 2,
    labelFilter: null,
    fetchUnestimated: async () => [],
    fetchEstimate: async () => null,
    hasSession: () => true,
    spawn: (id) => spawned.push(id),
    kill: (name) => killed.push(name),
    markRefined: (id) => refined.push(id),
    now: () => 1000,
    reapStaleMs: 90 * 60 * 1000,
    log: () => {},
    spawned, killed, refined,
    ...overrides,
  };
}

test("refineSessionName lowercases the identifier", () => {
  assert.equal(refineSessionName("ENG-9"), "refine-eng-9");
});

test("refineOnce is a no-op when disabled", async () => {
  const deps = makeDeps({ autoRefine: false, fetchUnestimated: async () => [issue("ENG-1")] });
  await refineOnce(freshRefineState(), deps);
  assert.deepEqual(deps.spawned, []);
});

test("refineOnce spawns sessions up to the cap and tracks them in flight", async () => {
  const deps = makeDeps({
    fetchUnestimated: async () => [issue("ENG-1"), issue("ENG-2"), issue("ENG-3")],
    hasSession: () => false,
  });
  const state = freshRefineState();
  await refineOnce(state, deps);
  assert.deepEqual(deps.spawned, ["ENG-1", "ENG-2"]);
  assert.deepEqual([...state.inFlight.keys()], ["ENG-1", "ENG-2"]);
});

test("refineOnce skips tickets outside the label filter", async () => {
  const deps = makeDeps({
    labelFilter: parseLabelFilter("bot"),
    fetchUnestimated: async () => [issue("ENG-1", ["infra"]), issue("ENG-2", ["bot"])],
    hasSession: () => false,
  });
  await refineOnce(freshRefineState(), deps);
  assert.deepEqual(deps.spawned, ["ENG-2"]);
});

test("refineOnce marks a ticket refined and kills its session when the estimate lands", async () => {
  const deps = makeDeps({ fetchEstimate: async () => 3 });
  const state = freshRefineState();
  state.inFlight.set("ENG-1", { title: "t", startedAt: 0 });
  await refineOnce(state, deps);
  assert.deepEqual(deps.refined, ["ENG-1"]);
  assert.deepEqual(deps.killed, ["refine-eng-1"]);
  assert.equal(state.inFlight.size, 0);
});

test("refineOnce frees the slot when the session died without an estimate", async () => {
  const deps = makeDeps({ hasSession: () => false });
  const state = freshRefineState();
  state.inFlight.set("ENG-1", { title: "t", startedAt: 0 });
  await refineOnce(state, deps);
  assert.equal(state.inFlight.size, 0);
  assert.deepEqual(deps.refined, []);
});

test("refineOnce reaps a session that outlived the stale window", async () => {
  const deps = makeDeps({ now: () => 100 * 60 * 1000, reapStaleMs: 90 * 60 * 1000 });
  const state = freshRefineState();
  state.inFlight.set("ENG-1", { title: "t", startedAt: 0 });
  await refineOnce(state, deps);
  assert.deepEqual(deps.killed, ["refine-eng-1"]);
  assert.equal(state.inFlight.size, 0);
});

test("refineOnce adopts an already-live session after a daemon restart instead of respawning", async () => {
  const deps = makeDeps({ fetchUnestimated: async () => [issue("ENG-1")], hasSession: () => true });
  const state = freshRefineState();
  await refineOnce(state, deps);
  assert.deepEqual(deps.spawned, []);
  assert.deepEqual([...state.inFlight.keys()], ["ENG-1"]);
});
