import assert from "node:assert/strict";
import { test } from "node:test";
import type { LinearIssue } from "./linear-api.ts";
import { buildSessionName, detectNewIssues, pollOnce, type WatchState } from "./watcher.ts";

function issue(id: string, identifier: string, title: string): LinearIssue {
  return { id, identifier, title };
}

function freshState(): WatchState {
  return { seen: new Set<string>(), initialized: false };
}

test("buildSessionName slugifies identifier and title", () => {
  assert.equal(buildSessionName("ENG-42", "Fix login flow!"), "eng-42-fix-login-flow");
});

test("buildSessionName caps length at 50 with no trailing dash", () => {
  const name = buildSessionName("ENG-123", "a very long title ".repeat(10));
  assert.ok(name.length <= 50);
  assert.match(name, /^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
});

test("detectNewIssues baselines on first call", () => {
  const state = freshState();
  const result = detectNewIssues(state, [issue("a", "ENG-1", "One")]);
  assert.deepEqual(result, []);
  assert.ok(state.seen.has("a"));
  assert.equal(state.initialized, true);
});

test("detectNewIssues returns only unseen issues after baseline", () => {
  const state = freshState();
  detectNewIssues(state, [issue("a", "ENG-1", "One")]);
  const result = detectNewIssues(state, [issue("a", "ENG-1", "One"), issue("b", "ENG-2", "Two")]);
  assert.deepEqual(result.map((i) => i.id), ["b"]);
  assert.ok(!state.seen.has("b"), "detectNewIssues must not mark seen; pollOnce does after launch");
});

test("pollOnce launches new issues and marks them seen", async () => {
  const state = freshState();
  const launched: string[] = [];
  const deps = {
    fetchIssues: async () => [issue("a", "ENG-1", "Fix bug")],
    launch: (name: string) => void launched.push(name),
    log: () => {},
  };
  await pollOnce(state, { ...deps, fetchIssues: async () => [] }); // baseline: empty board
  await pollOnce(state, deps);
  assert.deepEqual(launched, ["eng-1-fix-bug"]);
  assert.ok(state.seen.has("a"));
  await pollOnce(state, deps); // same issue again: no relaunch
  assert.deepEqual(launched, ["eng-1-fix-bug"]);
});

test("pollOnce retries an issue whose launch failed", async () => {
  const state = freshState();
  const launched: string[] = [];
  let fail = true;
  const deps = {
    fetchIssues: async () => [issue("a", "ENG-1", "Fix bug")],
    launch: (name: string) => {
      if (fail) throw new Error("tmux exploded");
      launched.push(name);
    },
    log: () => {},
  };
  await pollOnce(state, { ...deps, fetchIssues: async () => [] }); // baseline
  await pollOnce(state, deps); // launch fails
  assert.ok(!state.seen.has("a"));
  assert.deepEqual(launched, []);
  fail = false;
  await pollOnce(state, deps); // retried and succeeds
  assert.deepEqual(launched, ["eng-1-fix-bug"]);
  assert.ok(state.seen.has("a"));
});

test("pollOnce retries an issue whose async launch rejected", async () => {
  const state = freshState();
  const launched: string[] = [];
  let fail = true;
  const deps = {
    fetchIssues: async () => [issue("a", "ENG-1", "Fix bug")],
    launch: async (name: string) => {
      if (fail) throw new Error("spawn failed");
      launched.push(name);
    },
    log: () => {},
  };
  await pollOnce(state, { ...deps, fetchIssues: async () => [] }); // baseline
  await pollOnce(state, deps); // launch rejects
  assert.ok(!state.seen.has("a"), "rejected launch must not be marked seen");
  assert.deepEqual(launched, []);
  fail = false;
  await pollOnce(state, deps); // retried and succeeds
  assert.deepEqual(launched, ["eng-1-fix-bug"]);
  assert.ok(state.seen.has("a"));
});

test("pollOnce survives fetch failure without touching state", async () => {
  const state = freshState();
  await pollOnce(state, { fetchIssues: async () => [issue("a", "ENG-1", "One")], launch: () => {}, log: () => {} }); // baseline
  const logs: string[] = [];
  await pollOnce(state, {
    fetchIssues: async () => {
      throw new Error("network down");
    },
    launch: () => {
      throw new Error("must not launch");
    },
    log: (msg: string) => void logs.push(msg),
  });
  assert.ok(state.seen.has("a"), "seen-set must survive fetch failures");
  assert.ok(logs.some((l) => l.includes("network down")));
});
