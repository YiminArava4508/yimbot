import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRejectLabel, rejectTicket, shouldReject, type RejectDeps } from "./reject.ts";

test("shouldReject fires when planned is two or more steps above the estimate", () => {
  assert.equal(shouldReject(2, 5), true);
  assert.equal(shouldReject(3, 8), true);
  assert.equal(shouldReject(1, 3), true);
  assert.equal(shouldReject(2, 13), true);
});

test("shouldReject tolerates a single step of drift", () => {
  assert.equal(shouldReject(2, 3), false);
  assert.equal(shouldReject(5, 8), false);
});

test("shouldReject snaps an off-scale estimate up to the next scale value", () => {
  assert.equal(shouldReject(4, 8), false);
});

test("shouldReject never rejects an over-estimate, an unestimated ticket or a 0-point container", () => {
  assert.equal(shouldReject(8, 2), false);
  assert.equal(shouldReject(null, 8), false);
  assert.equal(shouldReject(0, 8), false);
});

test("parseRejectLabel defaults to reject and trims overrides", () => {
  assert.equal(parseRejectLabel(undefined), "rejected");
  assert.equal(parseRejectLabel("   "), "rejected");
  assert.equal(parseRejectLabel(" Blocked-Scope "), "Blocked-Scope");
});

function fakeDeps(estimate: number | null) {
  const calls: string[] = [];
  const deps: RejectDeps = {
    fetchTicket: async (id) => ({ id: "uuid-1", teamId: "team-1", identifier: id, estimate }),
    comment: async (issueId, body) => {
      calls.push(`comment:${issueId}:${body}`);
    },
    addLabel: async (issueId, teamId, label) => {
      calls.push(`label:${issueId}:${teamId}:${label}`);
    },
    moveToTodo: async (identifier) => {
      calls.push(`todo:${identifier}`);
    },
  };
  return { deps, calls };
}

test("rejectTicket comments with the reason, estimate and planned size, then labels", async () => {
  const { deps, calls } = fakeDeps(2);
  const result = await rejectTicket(deps, "reject", "ENG-1", 5, "touches 12 files");
  assert.deepEqual(result, { rejected: true, identifier: "ENG-1", estimate: 2 });
  assert.equal(calls.length, 3);
  assert.match(calls[0]!, /^comment:uuid-1:/);
  assert.match(calls[0]!, /touches 12 files/);
  assert.match(calls[0]!, /Estimate: 2, planned: 5/);
  assert.equal(calls[1], "label:uuid-1:team-1:reject");
  assert.equal(calls[2], "todo:ENG-1");
});

test("rejectTicket writes nothing when planned is within tolerance", async () => {
  const { deps, calls } = fakeDeps(2);
  const result = await rejectTicket(deps, "reject", "ENG-1", 3, "close enough");
  assert.deepEqual(result, { rejected: false, identifier: "ENG-1", estimate: 2 });
  assert.deepEqual(calls, []);
});
