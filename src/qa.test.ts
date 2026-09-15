import assert from "node:assert/strict";
import { test } from "node:test";
import { freshQaState, type QaUnit } from "./qa-state.ts";
import { QA_MARKER, qaConfigFor, qaOnce, qaRepoSlugEnvSuffix, qaSessionName, type QaDeps, type QaFamily } from "./qa.ts";

test("QA_MARKER is the documented marker", () => {
  assert.equal(QA_MARKER, "<!-- yimbot:qa -->");
});

test("qaSessionName lowercases the identifier behind a qa- prefix", () => {
  assert.equal(qaSessionName("ENG-90"), "qa-eng-90");
});

test("qaRepoSlugEnvSuffix uppercases and replaces non-alphanumerics", () => {
  assert.equal(qaRepoSlugEnvSuffix("acme/terraform-aws.platform"), "ACME_TERRAFORM_AWS_PLATFORM");
});

test("qaConfigFor reads primary and per-repo vars, null when either is missing", () => {
  const env = {
    QA_DEPLOY_WORKFLOW: "deploy.yml",
    QA_NONPROD_URL: "https://np.example",
    QA_DEPLOY_WORKFLOW_ACME_INFRA: "infra.yml",
    QA_NONPROD_URL_ACME_INFRA: "https://infra.example",
    QA_DEPLOY_WORKFLOW_ACME_HALF: "half.yml",
  };
  assert.deepEqual(qaConfigFor(env), { workflow: "deploy.yml", nonprodUrl: "https://np.example" });
  assert.deepEqual(qaConfigFor(env, "acme/infra"), { workflow: "infra.yml", nonprodUrl: "https://infra.example" });
  assert.equal(qaConfigFor(env, "acme/half"), null);
  assert.equal(qaConfigFor({}, undefined), null);
  assert.equal(qaConfigFor({ QA_DEPLOY_WORKFLOW: " ", QA_NONPROD_URL: "x" }), null);
});

type Fam = Record<string, QaFamily>;

function deps(over: Partial<QaDeps> & { families?: Fam; states?: Record<string, string> }): QaDeps & {
  emitted: string[];
  spawned: string[];
  killed: string[];
} {
  const emitted: string[] = [];
  const spawned: string[] = [];
  const killed: string[] = [];
  const families: Fam = over.families ?? {
    "ENG-101": { id: "u101", parent: "ENG-90", children: [] },
    "ENG-90": { id: "u90", parent: null, children: [{ identifier: "ENG-101", state: "Merged" }] },
  };
  const states = over.states ?? {};
  const base: QaDeps = {
    listMergedPRs: async () => [{ number: 12, headRefName: "eng-101-frontend" }],
    fetchFamily: async (id) => {
      const f = families[id];
      if (!f) throw new Error(`Entity not found: ${id}`);
      return f;
    },
    fetchState: async (id) => states[id] ?? "Todo",
    clearedStates: new Set(["Merged", "Done"]),
    configFor: () => ({ workflow: "deploy.yml", nonprodUrl: "https://np" }),
    mergeCommit: async () => "sha-merge",
    deployedHeadShas: async () => ["sha-merge"],
    isAncestorOrEqual: async (a, b) => a === b,
    hasMarker: async () => false,
    hasSession: () => true,
    kill: (n) => void killed.push(n),
    spawn: (u) => void spawned.push(u.identifier),
    activeCount: async () => 0,
    maxInProgress: 3,
    sessionTimeoutMs: 45 * 60_000,
    now: () => 10_000,
    emit: (k, id) => void emitted.push(`${k}:${id}`),
    log: () => {},
  };
  const { families: _f, states: _s, ...rest } = over;
  return { ...base, ...rest, emitted, spawned, killed };
}

test("a merged child PR creates a unit on the parent and latches the PR", async () => {
  const state = freshQaState();
  const d = deps({ deployedHeadShas: async () => [] });
  await qaOnce(state, d);
  const unit = state.units.get("ENG-90")!;
  assert.equal(unit.id, "u90");
  assert.equal(unit.lastPr, 12);
  assert.deepEqual(unit.prs, ["#12"]);
  assert.ok(state.processedPRs.has("#12"));
});

test("a ticket without a parent is its own unit and waits on its own state", async () => {
  const state = freshQaState();
  const d = deps({
    families: { "ENG-101": { id: "u101", parent: null, children: [] } },
    states: { "ENG-101": "In Progress" },
    deployedHeadShas: async () => [],
  });
  await qaOnce(state, d);
  assert.equal(state.units.get("ENG-101")!.phase, "waiting-children");
  assert.deepEqual(d.emitted, ["qa_waiting:ENG-101"]);
});

test("uncleared children hold the unit in waiting-children", async () => {
  const state = freshQaState();
  const d = deps({
    families: {
      "ENG-101": { id: "u101", parent: "ENG-90", children: [] },
      "ENG-90": {
        id: "u90",
        parent: null,
        children: [{ identifier: "ENG-101", state: "Merged" }, { identifier: "ENG-102", state: "In Progress" }],
      },
    },
  });
  await qaOnce(state, d);
  assert.equal(state.units.get("ENG-90")!.phase, "waiting-children");
  assert.deepEqual(d.spawned, []);
});

test("all children cleared records the merge sha and moves to awaiting-deploy, then spawns when deployed", async () => {
  const state = freshQaState();
  const d = deps({});
  await qaOnce(state, d);
  const unit = state.units.get("ENG-90")!;
  assert.equal(unit.phase, "in-session");
  assert.equal(unit.mergeSha, "sha-merge");
  assert.equal(unit.startedAt, 10_000);
  assert.deepEqual(d.spawned, ["ENG-90"]);
  assert.deepEqual(d.emitted, ["qa_awaiting_deploy:ENG-90", "qa_started:ENG-90"]);
});

test("a deploy head that is a descendant of the merge counts as deployed", async () => {
  const state = freshQaState();
  const d = deps({
    deployedHeadShas: async () => ["sha-later"],
    isAncestorOrEqual: async (base, head) => base === "sha-merge" && head === "sha-later",
  });
  await qaOnce(state, d);
  assert.equal(state.units.get("ENG-90")!.phase, "in-session");
});

test("an unrelated deploy head keeps the unit awaiting deploy", async () => {
  const state = freshQaState();
  const d = deps({ deployedHeadShas: async () => ["sha-old"], isAncestorOrEqual: async () => false });
  await qaOnce(state, d);
  assert.equal(state.units.get("ENG-90")!.phase, "awaiting-deploy");
  assert.deepEqual(d.spawned, []);
});

test("the WIP cap defers the spawn without changing phase", async () => {
  const state = freshQaState();
  const d = deps({ activeCount: async () => 3 });
  await qaOnce(state, d);
  assert.equal(state.units.get("ENG-90")!.phase, "awaiting-deploy");
  assert.deepEqual(d.spawned, []);
});

test("the marker appearing posts the unit and kills the session", async () => {
  const state = freshQaState();
  state.units.set("ENG-90", {
    identifier: "ENG-90", id: "u90", phase: "in-session", lastPr: 12, prs: ["#12"], mergeSha: "s", startedAt: 0,
  });
  const d = deps({ listMergedPRs: async () => [], hasMarker: async (id) => id === "u90" });
  await qaOnce(state, d);
  assert.equal(state.units.get("ENG-90")!.phase, "posted");
  assert.deepEqual(d.killed, ["qa-eng-90"]);
  assert.deepEqual(d.emitted, ["qa_posted:ENG-90"]);
});

test("a dead session without the marker fails the unit", async () => {
  const state = freshQaState();
  state.units.set("ENG-90", {
    identifier: "ENG-90", id: "u90", phase: "in-session", lastPr: 12, prs: ["#12"], mergeSha: "s", startedAt: 9_000,
  });
  const d = deps({ listMergedPRs: async () => [], hasSession: () => false });
  await qaOnce(state, d);
  assert.equal(state.units.get("ENG-90")!.phase, "failed");
  assert.deepEqual(d.emitted, ["qa_failed:ENG-90"]);
});

test("a session past the timeout is killed and failed", async () => {
  const state = freshQaState();
  state.units.set("ENG-90", {
    identifier: "ENG-90", id: "u90", phase: "in-session", lastPr: 12, prs: ["#12"], mergeSha: "s", startedAt: 0,
  });
  const d = deps({ listMergedPRs: async () => [], now: () => 46 * 60_000 });
  await qaOnce(state, d);
  assert.equal(state.units.get("ENG-90")!.phase, "failed");
  assert.deepEqual(d.killed, ["qa-eng-90"]);
});

test("a new PR on a posted unit restarts it from waiting-children", async () => {
  const state = freshQaState();
  state.units.set("ENG-90", {
    identifier: "ENG-90", id: "u90", phase: "posted", lastPr: 5, prs: ["#5"], mergeSha: "old",
  });
  const d = deps({ deployedHeadShas: async () => [] });
  await qaOnce(state, d);
  const unit = state.units.get("ENG-90")!;
  assert.equal(unit.lastPr, 12);
  assert.deepEqual(unit.prs, ["#5", "#12"]);
  assert.equal(unit.phase, "awaiting-deploy");
});

test("a repo without config is latched and never becomes a unit", async () => {
  const state = freshQaState();
  const d = deps({
    listMergedPRs: async () => [{ number: 3, headRefName: "eng-101-x", repo: "acme/infra" }],
    configFor: (repo) => (repo ? null : { workflow: "w", nonprodUrl: "u" }),
  });
  await qaOnce(state, d);
  assert.equal(state.units.size, 0);
  assert.ok(state.processedPRs.has("acme/infra#3"));
});

test("non-ticket branches are latched and skipped", async () => {
  const state = freshQaState();
  const d = deps({ listMergedPRs: async () => [{ number: 8, headRefName: "fix/typo" }] });
  await qaOnce(state, d);
  assert.equal(state.units.size, 0);
  assert.ok(state.processedPRs.has("#8"));
});

test("a transient failure leaves the phase and the latch untouched", async () => {
  const state = freshQaState();
  const d = deps({
    fetchFamily: async () => {
      throw new Error("linear down");
    },
  });
  await qaOnce(state, d);
  assert.equal(state.units.size, 0);
  assert.equal(state.processedPRs.size, 0);
});

test("a newly spawned session is not checked for liveness in the same tick it starts", async () => {
  const state = freshQaState();
  const d = deps({ hasSession: () => false });
  await qaOnce(state, d);
  const unit = state.units.get("ENG-90")!;
  assert.equal(unit.phase, "in-session");
  assert.deepEqual(d.killed, []);
  assert.ok(!d.emitted.includes("qa_failed:ENG-90"));

  d.hasSession = () => true;
  await qaOnce(state, d);
  assert.equal(state.units.get("ENG-90")!.phase, "in-session");
  assert.deepEqual(d.killed, []);
});

test("a second merged PR on an awaiting-deploy unit keeps its merge sha and phase", async () => {
  const state = freshQaState();
  state.units.set("ENG-90", {
    identifier: "ENG-90", id: "u90", phase: "awaiting-deploy", lastPr: 5, prs: ["#5"], mergeSha: "sha-old",
  });
  const d = deps({ deployedHeadShas: async () => [] });
  await qaOnce(state, d);
  const unit = state.units.get("ENG-90")!;
  assert.equal(unit.lastPr, 12);
  assert.deepEqual(unit.prs, ["#5", "#12"]);
  assert.equal(unit.phase, "awaiting-deploy");
  assert.equal(unit.mergeSha, "sha-old");
});

test("a second merged PR on an in-session unit keeps startedAt and does not fail", async () => {
  const state = freshQaState();
  state.units.set("ENG-90", {
    identifier: "ENG-90", id: "u90", phase: "in-session", lastPr: 5, prs: ["#5"], mergeSha: "sha-old", startedAt: 5_000,
  });
  const d = deps({});
  await qaOnce(state, d);
  const unit = state.units.get("ENG-90")!;
  assert.equal(unit.lastPr, 12);
  assert.equal(unit.phase, "in-session");
  assert.equal(unit.startedAt, 5_000);
  assert.deepEqual(d.emitted, []);
});

test("a merged PR whose Linear issue was deleted is latched instead of retried forever", async () => {
  const state = freshQaState();
  const d = deps({
    fetchFamily: async () => {
      throw new Error('Entity not found: no issue for identifier "ENG-101"');
    },
  });
  await qaOnce(state, d);
  assert.equal(state.units.size, 0);
  assert.ok(state.processedPRs.has("#12"));
});

test("a unit whose parent vanished is dropped", async () => {
  const state = freshQaState();
  const unit: QaUnit = { identifier: "ENG-90", id: "u90", phase: "waiting-children", lastPr: 12, prs: ["#12"] };
  state.units.set("ENG-90", unit);
  const d = deps({
    listMergedPRs: async () => [],
    fetchFamily: async () => {
      throw new Error('Entity not found: no issue for identifier "ENG-90"');
    },
  });
  await qaOnce(state, d);
  assert.equal(state.units.has("ENG-90"), false);
});
