import assert from "node:assert/strict";
import { test } from "node:test";
import type { LinearIssue } from "./linear-api.ts";
import {
  buildSessionName,
  detectNewIssues,
  findExistingSession,
  pollOnce,
  resumeExistingEnv,
  type WatchState,
} from "./watcher.ts";

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

test("findExistingSession matches a tmux session by identifier prefix", () => {
  const match = findExistingSession("ENG-42", ["eng-42-fix-login", "eng-7-other"], []);
  assert.equal(match, "eng-42-fix-login");
});

test("findExistingSession falls back to a worktree dir when no session matches", () => {
  const match = findExistingSession("ENG-42", ["eng-7-other"], ["eng-42-old-slug", "eng-99-x"]);
  assert.equal(match, "eng-42-old-slug");
});

test("findExistingSession matches despite a title change (identifier prefix only)", () => {
  // Worktree was created as eng-42-original-title; the issue title is now different.
  const match = findExistingSession("ENG-42", [], ["eng-42-original-title"]);
  assert.equal(match, "eng-42-original-title");
});

test("findExistingSession returns null when nothing matches", () => {
  assert.equal(findExistingSession("ENG-42", ["eng-7-a"], ["eng-9-b"]), null);
});

test("findExistingSession does not match a numeric-prefix neighbour", () => {
  // ENG-4 must not match eng-42-... — the boundary dash prevents it.
  assert.equal(findExistingSession("ENG-4", ["eng-42-fix-login"], []), null);
});

test("findExistingSession prefers a session over a worktree and picks deterministically", () => {
  const match = findExistingSession("ENG-42", ["eng-42-b", "eng-42-a"], ["eng-42-c"]);
  assert.equal(match, "eng-42-a");
});

test("resumeExistingEnv resumes the matched session and logs", async () => {
  const resumed: string[] = [];
  const logs: string[] = [];
  await resumeExistingEnv(issue("i", "ENG-42", "New title"), {
    listSessions: () => ["eng-42-old-title"],
    listWorktrees: () => ["eng-42-old-title"],
    resume: (name) => void resumed.push(name),
    log: (msg) => void logs.push(msg),
  });
  assert.deepEqual(resumed, ["eng-42-old-title"]);
  assert.ok(logs.some((l) => l.includes("ENG-42") && l.includes("eng-42-old-title")));
});

test("resumeExistingEnv skips (no resume, no throw) when nothing matches", async () => {
  const resumed: string[] = [];
  const logs: string[] = [];
  await resumeExistingEnv(issue("i", "ENG-42", "New title"), {
    listSessions: () => ["eng-7-x"],
    listWorktrees: () => ["eng-9-y"],
    resume: (name) => void resumed.push(name),
    log: (msg) => void logs.push(msg),
  });
  assert.deepEqual(resumed, []);
  assert.ok(logs.some((l) => l.includes("ENG-42") && /skip/i.test(l)));
});

test("resumeExistingEnv propagates resume errors so the poll retries", async () => {
  await assert.rejects(
    resumeExistingEnv(issue("i", "ENG-42", "t"), {
      listSessions: () => ["eng-42-a"],
      listWorktrees: () => [],
      resume: () => {
        throw new Error("tmux failed");
      },
      log: () => {},
    }),
    /tmux failed/,
  );
});
