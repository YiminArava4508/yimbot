import { test } from "node:test";
import assert from "node:assert/strict";
import { freshSelfImproveState, selfImproveOnce, selfImproveSessionName, type SelfImproveDeps } from "./self-improve.ts";
import type { SelfImproveJob } from "./self-improve-jobs.ts";

const jobA: SelfImproveJob = { id: "a", skill: "a", settingKey: "A", cadence: "daily", hour: 0, label: "job a" };
const jobB: SelfImproveJob = { id: "b", skill: "b", settingKey: "B", cadence: "daily", hour: 0, label: "job b" };
const STALE = 90 * 60_000;

function setup(overrides: Partial<SelfImproveDeps> = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const sessions = new Set<string>();
  const saved: Record<string, string> = {};
  let nowMs = new Date(2026, 10, 24, 1).getTime();
  const deps: SelfImproveDeps = {
    enabled: () => true,
    jobEnabled: () => true,
    jobs: [jobA, jobB],
    diskHeld: () => false,
    now: () => new Date(nowMs),
    loadState: () => ({ ...saved }),
    saveState: (s) => Object.assign(saved, s),
    hasSession: (n) => sessions.has(n),
    listSessions: () => [...sessions],
    branchFor: (job) => `chore/self-improve-${job.id}-2026-11-24`,
    existingBranch: () => null,
    prForBranch: async () => null,
    openSelfImprovePrs: async () => 0,
    spawn: (job, branch) => {
      calls.push(`spawn:${job.id}:${branch}`);
      sessions.add(selfImproveSessionName(job.id));
    },
    kill: (n) => {
      calls.push(`kill:${n}`);
      sessions.delete(n);
    },
    removeWorktree: (branch, del) => calls.push(`rm:${branch}:${del}`),
    markStarted: (job) => calls.push(`started:${job.id}`),
    markDone: (job, pr) => calls.push(`done:${job.id}:${pr}`),
    reapStaleMs: STALE,
    log: (m) => logs.push(m),
    ...overrides,
  };
  return {
    deps,
    calls,
    logs,
    sessions,
    saved,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

test("selfImproveSessionName prefixes the job id", () => {
  assert.equal(selfImproveSessionName("dead-code-scan"), "self-improve-dead-code-scan");
});

test("does nothing when the master switch is off", async () => {
  const h = setup({
    enabled: () => false,
    openSelfImprovePrs: async () => {
      throw new Error("must not look up");
    },
  });
  await selfImproveOnce(freshSelfImproveState(), h.deps);
  assert.deepEqual(h.calls, []);
});

test("skips a job whose own switch is off", async () => {
  const h = setup({ jobEnabled: (j) => j.id !== "a" });
  await selfImproveOnce(freshSelfImproveState(), h.deps);
  assert.deepEqual(h.calls, ["spawn:b:chore/self-improve-b-2026-11-24", "started:b"]);
});

test("skips before the job hour", async () => {
  const h = setup({ jobs: [{ ...jobA, hour: 3 }] });
  await selfImproveOnce(freshSelfImproveState(), h.deps);
  assert.deepEqual(h.calls, []);
});

test("skips a job that already ran this period", async () => {
  const h = setup({ loadState: () => ({ a: "2026-11-24", b: "2026-11-24" }) });
  await selfImproveOnce(freshSelfImproveState(), h.deps);
  assert.deepEqual(h.calls, []);
});

test("spawns the first due job, writes lastRun at spawn, and marks started", async () => {
  const h = setup();
  await selfImproveOnce(freshSelfImproveState(), h.deps);
  assert.deepEqual(h.calls, ["spawn:a:chore/self-improve-a-2026-11-24", "started:a"]);
  assert.equal(h.saved.a, "2026-11-24");
  assert.equal(h.saved.b, undefined);
});

test("spawns only one of two due jobs in a tick, the second after the first finishes", async () => {
  const state = freshSelfImproveState();
  const prs: Record<string, number | null> = {};
  const h = setup({ prForBranch: async (b) => prs[b] ?? null });
  await selfImproveOnce(state, h.deps);
  await selfImproveOnce(state, h.deps);
  assert.equal(h.calls.filter((c) => c.startsWith("spawn:")).length, 1);
  prs["chore/self-improve-a-2026-11-24"] = 7;
  await selfImproveOnce(state, h.deps);
  assert.equal(h.calls.filter((c) => c.startsWith("spawn:")).length, 2);
  assert.ok(h.calls.includes("spawn:b:chore/self-improve-b-2026-11-24"));
});

test("does not spawn while any self-improve session is in flight", async () => {
  const state = freshSelfImproveState();
  const h = setup();
  await selfImproveOnce(state, h.deps);
  h.calls.length = 0;
  await selfImproveOnce(state, h.deps);
  assert.deepEqual(h.calls, []);
});

test("does not spawn while a self-improvement PR is open", async () => {
  const h = setup({ openSelfImprovePrs: async () => 1 });
  await selfImproveOnce(freshSelfImproveState(), h.deps);
  assert.deepEqual(h.calls, []);
});

test("does not spawn when the open PR lookup rejects, and logs it", async () => {
  const h = setup({
    openSelfImprovePrs: async () => {
      throw new Error("gh down");
    },
  });
  await selfImproveOnce(freshSelfImproveState(), h.deps);
  assert.deepEqual(h.calls, []);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /gh down/);
});

test("does not spawn while the disk guard holds", async () => {
  const h = setup({ diskHeld: () => true });
  await selfImproveOnce(freshSelfImproveState(), h.deps);
  assert.deepEqual(h.calls, []);
});

test("does not write lastRun when spawn throws", async () => {
  const h = setup({
    spawn: () => {
      throw new Error("no script");
    },
  });
  const state = freshSelfImproveState();
  await selfImproveOnce(state, h.deps);
  assert.deepEqual(h.saved, {});
  assert.equal(state.inFlight.size, 0);
  assert.match(h.logs[0], /no script/);
});

test("done when the branch has a PR: kills, removes the worktree keeping the branch, marks done", async () => {
  const state = freshSelfImproveState();
  let pr: number | null = null;
  const h = setup({ jobs: [jobA], prForBranch: async () => pr });
  await selfImproveOnce(state, h.deps);
  h.calls.length = 0;
  pr = 42;
  await selfImproveOnce(state, h.deps);
  assert.deepEqual(h.calls.slice(0, 3), ["kill:self-improve-a", "rm:chore/self-improve-a-2026-11-24:false", "done:a:42"]);
  assert.equal(state.inFlight.size, 0);
});

test("session gone with no PR: removes worktree and branch, marks done with null, keeps lastRun", async () => {
  const state = freshSelfImproveState();
  const h = setup({ jobs: [jobA] });
  await selfImproveOnce(state, h.deps);
  h.calls.length = 0;
  h.sessions.clear();
  await selfImproveOnce(state, h.deps);
  assert.deepEqual(h.calls, ["rm:chore/self-improve-a-2026-11-24:true", "done:a:null"]);
  assert.equal(h.saved.a, "2026-11-24");
  assert.equal(state.inFlight.size, 0);
});

test("reaps a session older than reapStaleMs", async () => {
  const state = freshSelfImproveState();
  const h = setup({ jobs: [jobA] });
  await selfImproveOnce(state, h.deps);
  h.calls.length = 0;
  h.advance(STALE - 1);
  await selfImproveOnce(state, h.deps);
  assert.deepEqual(h.calls, []);
  h.advance(2);
  await selfImproveOnce(state, h.deps);
  assert.deepEqual(h.calls, ["kill:self-improve-a", "rm:chore/self-improve-a-2026-11-24:true", "done:a:null"]);
  assert.equal(state.inFlight.size, 0);
});

test("adopts a live self-improve session after a restart, reaps it when stale, never respawns", async () => {
  const state = freshSelfImproveState();
  const h = setup({ loadState: () => ({ a: "2026-11-24", b: "2026-11-24" }) });
  h.sessions.add("self-improve-a");
  await selfImproveOnce(state, h.deps);
  assert.equal(state.inFlight.has("a"), true);
  assert.equal(h.calls.length, 0);
  h.advance(STALE + 1);
  await selfImproveOnce(state, h.deps);
  assert.ok(h.calls.includes("kill:self-improve-a"));
  assert.equal(h.calls.filter((c) => c.startsWith("spawn:")).length, 0);
});

test("ignores live sessions that are not registered self-improve jobs", async () => {
  const state = freshSelfImproveState();
  const h = setup({ loadState: () => ({ a: "2026-11-24", b: "2026-11-24" }) });
  h.sessions.add("self-improve-unknown");
  h.sessions.add("refine-eng-1");
  await selfImproveOnce(state, h.deps);
  assert.equal(state.inFlight.size, 0);
});

test("skips the tick when the PR lookup for an in-flight run rejects", async () => {
  const state = freshSelfImproveState();
  let fail = false;
  const h = setup({
    prForBranch: async () => {
      if (fail) throw new Error("gh down");
      return null;
    },
  });
  await selfImproveOnce(state, h.deps);
  h.calls.length = 0;
  fail = true;
  await selfImproveOnce(state, h.deps);
  assert.deepEqual(h.calls, []);
  assert.equal(state.inFlight.size, 1);
  assert.match(h.logs[h.logs.length - 1], /gh down/);
});

test("adopts a live session with the branch of its existing worktree, not today's date", async () => {
  const state = freshSelfImproveState();
  const h = setup({
    jobs: [jobA],
    loadState: () => ({ a: "2026-11-24" }),
    existingBranch: () => "chore/self-improve-a-2026-11-23",
    prForBranch: async (b) => (b === "chore/self-improve-a-2026-11-23" ? 5 : null),
  });
  h.sessions.add("self-improve-a");
  await selfImproveOnce(state, h.deps);
  assert.ok(h.calls.includes("done:a:5"));
  assert.ok(h.calls.includes("rm:chore/self-improve-a-2026-11-23:false"));
});

test("removes a leftover worktree from a dead run before spawning, keeping the branch when it has a PR", async () => {
  let leftover: string | null = "chore/self-improve-a-2026-11-20";
  const h = setup({
    jobs: [jobA],
    existingBranch: () => leftover,
    prForBranch: async (b) => (b === "chore/self-improve-a-2026-11-20" ? 3 : null),
    removeWorktree: (b, del) => {
      leftover = null;
      h.calls.push(`rm:${b}:${del}`);
    },
  });
  await selfImproveOnce(freshSelfImproveState(), h.deps);
  assert.deepEqual(h.calls.slice(0, 3), [
    "rm:chore/self-improve-a-2026-11-20:false",
    "spawn:a:chore/self-improve-a-2026-11-24",
    "started:a",
  ]);
});

test("a leftover worktree with no PR is removed with its branch before spawning", async () => {
  let leftover: string | null = "chore/self-improve-a-2026-11-20";
  const h = setup({
    jobs: [jobA],
    existingBranch: () => leftover,
    removeWorktree: (b, del) => {
      leftover = null;
      h.calls.push(`rm:${b}:${del}`);
    },
  });
  await selfImproveOnce(freshSelfImproveState(), h.deps);
  assert.equal(h.calls[0], "rm:chore/self-improve-a-2026-11-20:true");
});

test("does not spawn when removing the leftover worktree throws, and logs it", async () => {
  const h = setup({
    jobs: [jobA],
    existingBranch: () => "chore/self-improve-a-2026-11-20",
    removeWorktree: () => {
      throw new Error("locked");
    },
  });
  await selfImproveOnce(freshSelfImproveState(), h.deps);
  assert.equal(h.calls.filter((c) => c.startsWith("spawn:")).length, 0);
  assert.match(h.logs[h.logs.length - 1], /locked/);
});
