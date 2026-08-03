import assert from "node:assert/strict";
import { test } from "node:test";
import type { AC } from "./acceptance.ts";
import { renderAcComment } from "./acceptance.ts";
import { type AdvanceDeps, advanceOnce, freshAdvanceState, issueFromBranch } from "./pr-advance.ts";

test("issueFromBranch extracts ENG id from ticket and continuation branches", () => {
  assert.equal(issueFromBranch("yiminarava/eng-949-create-offers"), "ENG-949");
  assert.equal(issueFromBranch("eng-949-cont-2"), "ENG-949");
  assert.equal(issueFromBranch("fix/wrike-thing"), null);
});

function acs(...ids: string[]): AC[] {
  return ids.map((id) => ({ id, section: id.split("-")[0], text: id, status: "open" as const }));
}

function baseDeps(over: Partial<AdvanceDeps>): AdvanceDeps {
  return {
    listMergedPRs: async () => [{ number: 10, headRefName: "eng-949-x" }],
    fetchAcComment: async () => renderAcComment(acs("pdf-1", "pdf-2")),
    fetchDescription: async () => ({ id: "uuid-949", description: "" }),
    judge: async () => ({ satisfied: ["pdf-1"], skipped: [] }),
    writeAcComment: async () => {},
    activeCount: () => 0,
    maxInProgress: 3,
    maxRounds: 5,
    spawnContinuation: () => {},
    log: () => {},
    ...over,
  };
}

test("advanceOnce spawns a continuation when ACs remain and a slot is free", async () => {
  const spawned: [string, number][] = [];
  const written: string[] = [];
  const deps = baseDeps({
    spawnContinuation: (n, r) => spawned.push([n, r]),
    writeAcComment: async (_id, body) => void written.push(body),
  });
  await advanceOnce(freshAdvanceState(), deps);
  assert.deepEqual(spawned, [["949", 1]]);
  assert.ok(written[0].includes("[x] `pdf-1`"));
});

test("advanceOnce defers on WIP cap without spawning or bumping round", async () => {
  const spawned: unknown[] = [];
  const state = freshAdvanceState();
  const deps = baseDeps({ activeCount: () => 3, spawnContinuation: () => spawned.push(1) });
  await advanceOnce(state, deps);
  assert.equal(spawned.length, 0);
  assert.equal(state.round.get("ENG-949") ?? 0, 0);
});

test("advanceOnce marks complete and does not spawn", async () => {
  const spawned: unknown[] = [];
  const deps = baseDeps({
    judge: async () => ({ satisfied: ["pdf-1", "pdf-2"], skipped: [] }),
    spawnContinuation: () => spawned.push(1),
  });
  await advanceOnce(freshAdvanceState(), deps);
  assert.equal(spawned.length, 0);
});

test("advanceOnce halts on no progress across a round", async () => {
  const state = freshAdvanceState();
  const spawned: unknown[] = [];
  // round 1 satisfies pdf-1; force judge to satisfy nothing new next round
  const deps = baseDeps({ spawnContinuation: () => spawned.push(1) });
  await advanceOnce(state, deps); // round 0 -> spawns, prev=1, round=1
  const deps2 = baseDeps({
    judge: async () => ({ satisfied: ["pdf-1"], skipped: [] }), // still only pdf-1
    spawnContinuation: () => spawned.push(1),
  });
  await advanceOnce(state, deps2); // round 1, satisfied 1 <= prev 1 -> halt
  assert.equal(spawned.length, 1);
  assert.ok(state.halted.has("ENG-949"));
});

test("advanceOnce skips issues without an AC tracker comment", async () => {
  const spawned: unknown[] = [];
  const deps = baseDeps({ fetchAcComment: async () => "no marker here", spawnContinuation: () => spawned.push(1) });
  await advanceOnce(freshAdvanceState(), deps);
  assert.equal(spawned.length, 0);
});
