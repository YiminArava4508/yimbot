import assert from "node:assert/strict";
import { test } from "node:test";
import type { AC } from "./acceptance.ts";
import { renderAcComment } from "./acceptance.ts";
import { type AdvanceDeps, advanceOnce, freshAdvanceState, isContinuationBranch, issueFromBranch } from "./pr-advance.ts";

test("issueFromBranch extracts ENG id from ticket and continuation branches", () => {
  assert.equal(issueFromBranch("yiminarava/eng-949-create-offers"), "ENG-949");
  assert.equal(issueFromBranch("eng-949-cont-2"), "ENG-949");
  assert.equal(issueFromBranch("fix/wrike-thing"), null);
});

test("isContinuationBranch matches only the eng-<n>-cont-<round> shape", () => {
  assert.equal(isContinuationBranch("eng-949-cont-2"), true);
  assert.equal(isContinuationBranch("eng-949-create-offers"), false);
  assert.equal(isContinuationBranch("eng-949-contour"), false);
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
    activeCount: async () => 0,
    maxInProgress: 3,
    maxRounds: 5,
    spawnContinuation: () => {},
    markReady: () => {},
    log: () => {},
    ...over,
  };
}

test("advanceOnce spawns a continuation when ACs remain and a slot is free", async () => {
  const spawned: [string, number][] = [];
  const written: string[] = [];
  const state = freshAdvanceState();
  const deps = baseDeps({
    spawnContinuation: (n, r) => spawned.push([n, r]),
    writeAcComment: async (_id, body) => void written.push(body),
  });
  await advanceOnce(state, deps);
  assert.deepEqual(spawned, [["949", 1]]);
  assert.ok(written[0].includes("[x] `pdf-1`"));
  assert.ok(state.processedPRs.has(10));
});

test("advanceOnce defers on WIP cap without spawning or bumping round", async () => {
  const spawned: unknown[] = [];
  const state = freshAdvanceState();
  const deps = baseDeps({ activeCount: async () => 3, spawnContinuation: () => spawned.push(1) });
  await advanceOnce(state, deps);
  assert.equal(spawned.length, 0);
  assert.equal(state.round.get("ENG-949") ?? 0, 0);
  assert.ok(!state.processedPRs.has(10)); // deferred, so it retries next tick
});

test("advanceOnce marks complete, flags ready, and does not spawn", async () => {
  const spawned: unknown[] = [];
  const readied: string[] = [];
  const state = freshAdvanceState();
  const deps = baseDeps({
    judge: async () => ({ satisfied: ["pdf-1", "pdf-2"], skipped: [] }),
    spawnContinuation: () => spawned.push(1),
    markReady: (identifier) => readied.push(identifier),
  });
  await advanceOnce(state, deps);
  assert.equal(spawned.length, 0);
  assert.deepEqual(readied, ["ENG-949"]);
  assert.ok(state.processedPRs.has(10));
});

test("advanceOnce halts on no progress across a round", async () => {
  const state = freshAdvanceState();
  const spawned: unknown[] = [];
  // First tick: PR 10 new -> round 0 spawns, prev=1, round=1, processed={10}.
  const deps = baseDeps({ spawnContinuation: () => spawned.push(1) });
  await advanceOnce(state, deps);
  // Second tick: PR 11 (a completed continuation round) is new, PR 10 already
  // processed. Judge still satisfies only pdf-1, so satisfied 1 <= prev 1 -> halt.
  const deps2 = baseDeps({
    listMergedPRs: async () => [
      { number: 10, headRefName: "eng-949-x" },
      { number: 11, headRefName: "eng-949-cont-1" },
    ],
    judge: async () => ({ satisfied: ["pdf-1"], skipped: [] }),
    spawnContinuation: () => spawned.push(1),
  });
  await advanceOnce(state, deps2);
  assert.equal(spawned.length, 1);
  assert.ok(state.halted.has("ENG-949"));
});

test("advanceOnce skips issues without an AC tracker comment", async () => {
  const spawned: unknown[] = [];
  const state = freshAdvanceState();
  const deps = baseDeps({ fetchAcComment: async () => "no marker here", spawnContinuation: () => spawned.push(1) });
  await advanceOnce(state, deps);
  assert.equal(spawned.length, 0);
  assert.ok(state.processedPRs.has(10)); // marked so it is not re-scanned
});

test("advanceOnce does not re-judge or re-spawn an already-processed PR", async () => {
  const state = freshAdvanceState();
  const spawned: unknown[] = [];
  let judgeCalls = 0;
  const mk = () =>
    baseDeps({
      judge: async () => {
        judgeCalls++;
        return { satisfied: ["pdf-1"], skipped: [] };
      },
      spawnContinuation: () => spawned.push(1),
    });
  await advanceOnce(state, mk());
  assert.equal(judgeCalls, 1);
  assert.equal(spawned.length, 1);
  await advanceOnce(state, mk()); // same PR list; already processed
  assert.equal(judgeCalls, 1);
  assert.equal(spawned.length, 1);
});
