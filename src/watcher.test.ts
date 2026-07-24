import assert from "node:assert/strict";
import { test } from "node:test";
import type { CycleTodoIssue, LinearIssue } from "./linear-api.ts";
import {
  buildSessionName,
  claimOnce,
  type ClaimDeps,
  type DeployDeps,
  deployOnce,
  detectNewIssues,
  findExistingSession,
  freshDeployState,
  markFeatureReady,
  parseWorktreePorcelain,
  pollOnce,
  sanitizeBranchToSession,
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

function deployDeps(overrides: Partial<DeployDeps> = {}): {
  deps: DeployDeps;
  launched: string[];
  logs: string[];
} {
  const launched: string[] = [];
  const logs: string[] = [];
  const deps: DeployDeps = {
    fetchIssues: async () => [issue("a", "ENG-1", "Fix bug")],
    listSessions: () => [],
    listWorktrees: () => [],
    launch: (name) => void launched.push(name),
    log: (m) => void logs.push(m),
    ...overrides,
  };
  return { deps, launched, logs };
}

test("deployOnce launches an orphaned In-Progress issue and latches it (no relaunch)", async () => {
  const state = freshDeployState();
  const { deps, launched } = deployDeps();
  await deployOnce(state, deps);
  await deployOnce(state, deps);
  assert.deepEqual(launched, ["eng-1-fix-bug"]);
  assert.ok(state.launched.has("a"));
});

test("deployOnce adopts an existing session without launching (restart-safe)", async () => {
  const state = freshDeployState();
  const { deps, launched } = deployDeps({ listSessions: () => ["eng-1-existing"] });
  await deployOnce(state, deps);
  assert.deepEqual(launched, [], "a live session means the ticket is already handled");
  assert.ok(state.launched.has("a"), "adopted issues are latched too");
});

test("deployOnce adopts an existing worktree despite a title change (restart-safe)", async () => {
  const state = freshDeployState();
  const { deps, launched } = deployDeps({ listWorktrees: () => ["eng-1-old-slug"] });
  await deployOnce(state, deps);
  assert.deepEqual(launched, []);
  assert.ok(state.launched.has("a"));
});

test("deployOnce does not relaunch after cleanup removes the worktree (latched)", async () => {
  const state = freshDeployState();
  let worktrees: string[] = [];
  const { deps, launched } = deployDeps({ listWorktrees: () => worktrees });
  await deployOnce(state, deps); // orphaned → launch, latched
  assert.deepEqual(launched, ["eng-1-fix-bug"]);
  worktrees = []; // cleanup removed the worktree; ticket still In Progress
  await deployOnce(state, deps); // latched → must not relaunch
  assert.deepEqual(launched, ["eng-1-fix-bug"]);
});

test("deployOnce retries an issue whose launch failed (not latched on failure)", async () => {
  const state = freshDeployState();
  const launched: string[] = [];
  let fail = true;
  const { deps } = deployDeps({
    launch: (name) => {
      if (fail) throw new Error("tmux exploded");
      launched.push(name);
    },
  });
  await deployOnce(state, deps);
  assert.ok(!state.launched.has("a"), "a failed launch must not be latched");
  assert.deepEqual(launched, []);
  fail = false;
  await deployOnce(state, deps);
  assert.deepEqual(launched, ["eng-1-fix-bug"]);
  assert.ok(state.launched.has("a"));
});

test("deployOnce survives a fetch failure without launching or latching", async () => {
  const state = freshDeployState();
  const logs: string[] = [];
  await deployOnce(state, {
    fetchIssues: async () => {
      throw new Error("network down");
    },
    listSessions: () => [],
    listWorktrees: () => [],
    launch: () => {
      throw new Error("must not launch");
    },
    log: (m) => void logs.push(m),
  });
  assert.equal(state.launched.size, 0);
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

test("parseWorktreePorcelain returns path+branch for each branched worktree", () => {
  const out = [
    "worktree /home/ymbo/Work/gemini",
    "HEAD abc123",
    "branch refs/heads/main",
    "",
    "worktree /home/ymbo/Work/worktrees/eng-42-foo",
    "HEAD def456",
    "branch refs/heads/eng-42-foo",
    "",
  ].join("\n");
  assert.deepEqual(parseWorktreePorcelain(out), [
    { path: "/home/ymbo/Work/gemini", branch: "main" },
    { path: "/home/ymbo/Work/worktrees/eng-42-foo", branch: "eng-42-foo" },
  ]);
});

test("parseWorktreePorcelain skips detached-HEAD and bare worktrees (no branch)", () => {
  const out = [
    "worktree /home/ymbo/Work/worktrees/eng-1-a",
    "HEAD abc",
    "branch refs/heads/eng-1-a",
    "",
    "worktree /home/ymbo/Work/worktrees/detached",
    "HEAD def",
    "detached",
    "",
    "worktree /home/ymbo/Work/gemini/.bare",
    "bare",
    "",
  ].join("\n");
  assert.deepEqual(parseWorktreePorcelain(out), [
    { path: "/home/ymbo/Work/worktrees/eng-1-a", branch: "eng-1-a" },
  ]);
});

test("parseWorktreePorcelain skips prunable worktrees (dir gone, would die-loop)", () => {
  const out = [
    "worktree /home/ymbo/Work/worktrees/eng-1-a",
    "HEAD abc",
    "branch refs/heads/eng-1-a",
    "",
    "worktree /home/ymbo/Work/worktrees/eng-2-gone",
    "HEAD def",
    "branch refs/heads/eng-2-gone",
    "prunable gitdir file points to non-existent location",
    "",
  ].join("\n");
  assert.deepEqual(parseWorktreePorcelain(out), [
    { path: "/home/ymbo/Work/worktrees/eng-1-a", branch: "eng-1-a" },
  ]);
});

test("parseWorktreePorcelain handles a trailing entry with no final blank line", () => {
  const out = ["worktree /wt/eng-7-g", "HEAD a", "branch refs/heads/eng-7-g"].join("\n");
  assert.deepEqual(parseWorktreePorcelain(out), [{ path: "/wt/eng-7-g", branch: "eng-7-g" }]);
});

test("sanitizeBranchToSession matches new-session.sh's rule (no-op on a clean slug)", () => {
  assert.equal(sanitizeBranchToSession("eng-4706-add-foo"), "eng-4706-add-foo");
});

test("sanitizeBranchToSession replaces disallowed chars and caps at 50", () => {
  assert.equal(sanitizeBranchToSession("feat/ENG-42_fix bar"), "feat-ENG-42-fix-bar");
  assert.equal(sanitizeBranchToSession("x".repeat(60)).length, 50);
});

test("findExistingSession does not match a numeric-prefix neighbour", () => {
  // ENG-4 must not match eng-42-... — the boundary dash prevents it.
  assert.equal(findExistingSession("ENG-4", ["eng-42-fix-login"], []), null);
});

test("findExistingSession prefers a session over a worktree and picks deterministically", () => {
  const match = findExistingSession("ENG-42", ["eng-42-b", "eng-42-a"], ["eng-42-c"]);
  assert.equal(match, "eng-42-a");
});

test("markFeatureReady flags the matched session and logs", () => {
  const flagged: string[] = [];
  const logs: string[] = [];
  markFeatureReady(issue("i", "ENG-42", "New title"), {
    listSessions: () => ["eng-42-old-title"],
    listWorktrees: () => ["eng-42-old-title"],
    markReady: (name) => void flagged.push(name),
    log: (msg) => void logs.push(msg),
  });
  assert.deepEqual(flagged, ["eng-42-old-title"]);
  assert.ok(logs.some((l) => l.includes("ENG-42") && l.includes("eng-42-old-title")));
});

test("markFeatureReady skips (no flag) when nothing matches", () => {
  const flagged: string[] = [];
  const logs: string[] = [];
  markFeatureReady(issue("i", "ENG-42", "New title"), {
    listSessions: () => ["eng-7-x"],
    listWorktrees: () => ["eng-9-y"],
    markReady: (name) => void flagged.push(name),
    log: (msg) => void logs.push(msg),
  });
  assert.deepEqual(flagged, []);
  assert.ok(logs.some((l) => l.includes("ENG-42") && /skip/i.test(l)));
});

function cycleTodo(overrides: Partial<CycleTodoIssue> & { id: string }): CycleTodoIssue {
  return {
    identifier: `ENG-${overrides.id}`,
    title: `Issue ${overrides.id}`,
    priority: 0,
    sortOrder: 0,
    labels: [],
    ...overrides,
  };
}

function claimDeps(overrides: Partial<ClaimDeps> = {}): {
  deps: ClaimDeps;
  moved: CycleTodoIssue[];
  logs: string[];
} {
  const moved: CycleTodoIssue[] = [];
  const logs: string[] = [];
  const deps: ClaimDeps = {
    autoClaim: true,
    riskLabels: ["migration"],
    maxInProgress: 3,
    countInProgress: async () => 0,
    fetchCycleTodos: async () => [cycleTodo({ id: "1", priority: 1 })],
    moveToInProgress: async (issue) => void moved.push(issue),
    log: (msg) => void logs.push(msg),
    ...overrides,
  };
  return { deps, moved, logs };
}

test("claimOnce does nothing when autoClaim is off", async () => {
  let counted = false;
  const { deps, moved } = claimDeps({
    autoClaim: false,
    countInProgress: async () => {
      counted = true;
      return 0;
    },
  });
  await claimOnce(deps);
  assert.equal(moved.length, 0);
  assert.equal(counted, false, "must not even query counts when disabled");
});

test("claimOnce still claims when In-Progress count is below the cap", async () => {
  const { deps, moved } = claimDeps({ maxInProgress: 3, countInProgress: async () => 1 });
  await claimOnce(deps);
  assert.equal(moved.length, 1);
});

test("claimOnce skips (no pick) when In-Progress count is at the cap", async () => {
  const { deps, moved } = claimDeps({ maxInProgress: 2, countInProgress: async () => 2 });
  await claimOnce(deps);
  assert.equal(moved.length, 0);
});

test("claimOnce moves the selected top-priority ticket to In Progress", async () => {
  const { deps, moved, logs } = claimDeps({
    fetchCycleTodos: async () => [
      cycleTodo({ id: "low", priority: 3 }),
      cycleTodo({ id: "urgent", priority: 1 }),
    ],
  });
  await claimOnce(deps);
  assert.deepEqual(moved.map((i) => i.id), ["urgent"]);
  assert.ok(logs.some((l) => l.includes("ENG-urgent")));
});

test("claimOnce picks nothing when no eligible Todo exists", async () => {
  const { deps, moved } = claimDeps({
    fetchCycleTodos: async () => [cycleTodo({ id: "risky", labels: ["migration"] })],
  });
  await claimOnce(deps);
  assert.equal(moved.length, 0);
});

test("claimOnce logs and swallows a move failure without throwing", async () => {
  const { deps, logs } = claimDeps({
    moveToInProgress: async () => {
      throw new Error("linear 500");
    },
  });
  await claimOnce(deps);
  assert.ok(logs.some((l) => /linear 500/.test(l)));
});

test("claimOnce swallows a count failure without throwing or moving", async () => {
  const { deps, moved, logs } = claimDeps({
    countInProgress: async () => {
      throw new Error("count 503");
    },
  });
  await claimOnce(deps); // must not throw
  assert.equal(moved.length, 0);
  assert.ok(logs.some((l) => /count 503/.test(l)));
});

test("claimOnce swallows a fetchCycleTodos failure without throwing or moving", async () => {
  const { deps, moved, logs } = claimDeps({
    fetchCycleTodos: async () => {
      throw new Error("todos 503");
    },
  });
  await claimOnce(deps); // must not throw
  assert.equal(moved.length, 0);
  assert.ok(logs.some((l) => /todos 503/.test(l)));
});
