import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CycleTodoIssue, LinearIssue } from "./linear-api.ts";
import {
  bindReturnKey,
  buildSessionName,
  claimOnce,
  type ClaimDeps,
  continuationSessionName,
  currentTmuxPane,
  type DependencyScanDeps,
  type DeployDeps,
  deployOnce,
  detectNewIssues,
  findExistingSession,
  freshClaimState,
  freshDeployState,
  hasSessionForWorktree,
  isLaunchMarkerActive,
  markFeatureReady,
  parseWorktreePorcelain,
  pollOnce,
  porcelainHasNonMarkerChanges,
  reconcileBlockedInProgress,
  type ReconcileDeps,
  resolveSessionForKey,
  returnKeyBindArgs,
  returnKeyUnbindArgs,
  sanitizeBranchToSession,
  unbindReturnKey,
  type WatchState,
  worktreeFullyPushed,
  worktreeKeysUnder,
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

test("continuationSessionName is keyed by issue number and round", () => {
  assert.equal(continuationSessionName("949", 2), "eng-949-cont-2");
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

test("worktreeKeysUnder derives ticket keys for worktrees under the dir only", () => {
  const keys = worktreeKeysUnder(
    [
      { path: "/home/u/Work/worktrees/eng-1417-polish", branch: "eng-1417-polish" },
      { path: "/home/u/Work/worktrees/release-thing", branch: "release-thing" },
      { path: "/home/u/Work/gemini", branch: "main" }, // main checkout, outside dir
      { path: "/home/u/Work/worktrees/readme-diagrams", branch: "docs/readme-diagrams" },
    ],
    "/home/u/Work/worktrees",
  );
  assert.deepEqual([...keys].sort(), ["ENG-1417", "docs/readme-diagrams", "release-thing"]);
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

test("hasSessionForWorktree matches a full-length session against a 50-char-truncated worktree name", () => {
  // new-session.sh names the session with the full title but truncates the
  // worktree dir to 50 chars; they must still be recognized as the same ticket.
  const worktreeName = "eng-1104-spike-validate-data-sources-for-personali"; // 50 chars
  const session = "eng-1104-spike-validate-data-sources-for-personalized-digest-content";
  assert.equal(hasSessionForWorktree(worktreeName, [session]), true);
});

test("hasSessionForWorktree is false when no session shares the ticket", () => {
  assert.equal(hasSessionForWorktree("eng-42-fix-login", ["eng-7-other"]), false);
  assert.equal(hasSessionForWorktree("eng-42-fix-login", []), false);
});

test("hasSessionForWorktree spares (true) a worktree name with no parseable identifier", () => {
  assert.equal(hasSessionForWorktree("some-random-dir", []), true);
});

const TTL = 30 * 60_000;
const NOW = 1_000_000_000_000;

test("isLaunchMarkerActive is true for a marker written within the TTL", () => {
  assert.equal(isLaunchMarkerActive(NOW - 60_000, NOW, TTL), true);
});

test("isLaunchMarkerActive is false for a stale (leaked) marker past the TTL", () => {
  // e.g. new-session.sh was SIGKILL/OOM-killed mid-launch, leaking the marker;
  // past the ceiling the worktree falls back to the normal sweep guards.
  assert.equal(isLaunchMarkerActive(NOW - TTL - 1, NOW, TTL), false);
});

test("isLaunchMarkerActive is false when the marker is absent", () => {
  assert.equal(isLaunchMarkerActive(null, NOW, TTL), false);
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

function gitIn(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// A real temp repo pair: a bare "origin" and a clone with one pushed commit on
// main. Returns the clone path; callers mutate it per case.
function tempClone(): string {
  const root = mkdtempSync(join(tmpdir(), "yimbot-push-test-"));
  const bare = join(root, "origin.git");
  const clone = join(root, "clone");
  gitIn(root, ["init", "--bare", "-b", "main", bare]);
  gitIn(root, ["clone", bare, clone]);
  gitIn(clone, ["config", "user.email", "t@t"]);
  gitIn(clone, ["config", "user.name", "t"]);
  gitIn(clone, ["commit", "--allow-empty", "-m", "init"]);
  gitIn(clone, ["push", "origin", "main"]);
  return clone;
}

test("worktreeFullyPushed accepts a clean never-pushed branch with no local-only commits", () => {
  // A spike's branch: created off main, never pushed, no upstream. Everything on
  // it is reachable from origin/main, so nothing would be lost.
  const clone = tempClone();
  gitIn(clone, ["checkout", "-b", "eng-1104-spike"]);
  assert.equal(worktreeFullyPushed(clone), true);
});

test("worktreeFullyPushed rejects a branch with a local-only commit", () => {
  const clone = tempClone();
  gitIn(clone, ["checkout", "-b", "eng-1104-spike"]);
  gitIn(clone, ["commit", "--allow-empty", "-m", "local scaffolding"]);
  assert.equal(worktreeFullyPushed(clone), false);
});

test("worktreeFullyPushed accepts a branch whose commits are all pushed to its origin branch", () => {
  const clone = tempClone();
  gitIn(clone, ["checkout", "-b", "eng-1104-spike"]);
  gitIn(clone, ["commit", "--allow-empty", "-m", "kept for reference"]);
  gitIn(clone, ["push", "-u", "origin", "eng-1104-spike"]);
  assert.equal(worktreeFullyPushed(clone), true);
});

test("worktreeFullyPushed rejects a dirty working tree", () => {
  const clone = tempClone();
  writeFileSync(join(clone, "scratch.txt"), "wip");
  assert.equal(worktreeFullyPushed(clone), false);
});

test("porcelainHasNonMarkerChanges ignores yimbot marker files", () => {
  // A worktree dirty only with its own daemon markers is clean for reap purposes.
  assert.equal(porcelainHasNonMarkerChanges("?? .yimbot-parent-session\n"), false);
  assert.equal(porcelainHasNonMarkerChanges("?? .yimbot-split-parent\n?? .yimbot-launching\n"), false);
  assert.equal(porcelainHasNonMarkerChanges(""), false);
});

test("porcelainHasNonMarkerChanges reports real changes even alongside markers", () => {
  assert.equal(porcelainHasNonMarkerChanges("?? .yimbot-split-parent\n M src/foo.ts\n"), true);
  assert.equal(porcelainHasNonMarkerChanges("?? newfile.txt\n"), true);
  assert.equal(porcelainHasNonMarkerChanges(" M src/a.ts\n"), true);
});

test("findExistingSession does not match a numeric-prefix neighbour", () => {
  // ENG-4 must not match eng-42-... — the boundary dash prevents it.
  assert.equal(findExistingSession("ENG-4", ["eng-42-fix-login"], []), null);
});

test("findExistingSession prefers a session over a worktree and picks deterministically", () => {
  const match = findExistingSession("ENG-42", ["eng-42-b", "eng-42-a"], ["eng-42-c"]);
  assert.equal(match, "eng-42-a");
});

test("resolveSessionForKey returns the live session whose branch maps to the key", () => {
  const worktrees = [{ path: "/wt/eng-42-fix-login", branch: "eng-42-fix-login" }];
  const session = resolveSessionForKey("ENG-42", worktrees, ["eng-42-fix-login", "eng-7-other"]);
  assert.equal(session, "eng-42-fix-login");
});

test("resolveSessionForKey matches despite a title change since launch", () => {
  const worktrees = [{ path: "/wt/eng-42-new-title", branch: "eng-42-new-title" }];
  const session = resolveSessionForKey("ENG-42", worktrees, ["eng-42-old-title"]);
  assert.equal(session, "eng-42-old-title");
});

test("resolveSessionForKey returns null when no worktree backs the key", () => {
  const worktrees = [{ path: "/wt/eng-7-other", branch: "eng-7-other" }];
  assert.equal(resolveSessionForKey("ENG-42", worktrees, ["eng-7-other"]), null);
});

test("resolveSessionForKey returns null when the worktree has no live session", () => {
  const worktrees = [{ path: "/wt/eng-42-fix-login", branch: "eng-42-fix-login" }];
  assert.equal(resolveSessionForKey("ENG-42", worktrees, []), null);
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
    description: "",
    priority: 0,
    sortOrder: 0,
    labels: [],
    blockedBy: [],
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

function scanDeps(overrides: Partial<DependencyScanDeps> = {}): {
  scan: DependencyScanDeps;
  relations: [string, string][];
  markers: [string, string][];
} {
  const relations: [string, string][] = [];
  const markers: [string, string][] = [];
  const scan: DependencyScanDeps = {
    fetchMarker: async () => "",
    scan: async () => ["ENG-1319"],
    resolveId: async (identifier) => `uuid-${identifier}`,
    createRelation: async (blockerId, blockedId) => void relations.push([blockerId, blockedId]),
    writeMarker: async (issueId, body) => void markers.push([issueId, body]),
    ...overrides,
  };
  return { scan, relations, markers };
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
  await claimOnce(freshClaimState(), deps);
  assert.equal(moved.length, 0);
  assert.equal(counted, false, "must not even query counts when disabled");
});

test("claimOnce still claims when In-Progress count is below the cap", async () => {
  const { deps, moved } = claimDeps({ maxInProgress: 3, countInProgress: async () => 1 });
  await claimOnce(freshClaimState(), deps);
  assert.equal(moved.length, 1);
});

test("claimOnce skips (no pick) when In-Progress count is at the cap", async () => {
  const { deps, moved } = claimDeps({ maxInProgress: 2, countInProgress: async () => 2 });
  await claimOnce(freshClaimState(), deps);
  assert.equal(moved.length, 0);
});

test("claimOnce defers a blocked todo and logs it when merged is available", async () => {
  const { deps, moved, logs } = claimDeps({
    fetchCycleTodos: async () => [cycleTodo({ id: "5", priority: 1, blockedBy: ["ENG-4"] })],
    fetchMergedIdentifiers: async () => new Set<string>(),
  });
  await claimOnce(freshClaimState(), deps);
  assert.equal(moved.length, 0);
  assert.ok(logs.some((l) => l.includes("deferring ENG-5") && l.includes("ENG-4")));
});

test("claimOnce claims a blocked todo once its blocker is merged", async () => {
  const { deps, moved } = claimDeps({
    fetchCycleTodos: async () => [cycleTodo({ id: "5", priority: 1, blockedBy: ["ENG-4"] })],
    fetchMergedIdentifiers: async () => new Set(["ENG-4"]),
  });
  await claimOnce(freshClaimState(), deps);
  assert.deepEqual(moved.map((i) => i.id), ["5"]);
});

test("claimOnce skips the claim tick if the merged fetch fails", async () => {
  const { deps, moved, logs } = claimDeps({
    fetchMergedIdentifiers: async () => {
      throw new Error("gh boom");
    },
  });
  await claimOnce(freshClaimState(), deps); // must not throw
  assert.equal(moved.length, 0);
  assert.ok(logs.some((l) => l.includes("claim failed")));
});

test("claimOnce moves the selected top-priority ticket to In Progress", async () => {
  const { deps, moved, logs } = claimDeps({
    fetchCycleTodos: async () => [
      cycleTodo({ id: "low", priority: 3 }),
      cycleTodo({ id: "urgent", priority: 1 }),
    ],
  });
  await claimOnce(freshClaimState(), deps);
  assert.deepEqual(moved.map((i) => i.id), ["urgent"]);
  assert.ok(logs.some((l) => l.includes("ENG-urgent")));
});

test("claimOnce picks nothing when no eligible Todo exists", async () => {
  const { deps, moved } = claimDeps({
    fetchCycleTodos: async () => [cycleTodo({ id: "risky", labels: ["migration"] })],
  });
  await claimOnce(freshClaimState(), deps);
  assert.equal(moved.length, 0);
});

test("claimOnce logs and swallows a move failure without throwing", async () => {
  const { deps, logs } = claimDeps({
    moveToInProgress: async () => {
      throw new Error("linear 500");
    },
  });
  await claimOnce(freshClaimState(), deps);
  assert.ok(logs.some((l) => /linear 500/.test(l)));
});

test("claimOnce swallows a count failure without throwing or moving", async () => {
  const { deps, moved, logs } = claimDeps({
    countInProgress: async () => {
      throw new Error("count 503");
    },
  });
  await claimOnce(freshClaimState(), deps); // must not throw
  assert.equal(moved.length, 0);
  assert.ok(logs.some((l) => /count 503/.test(l)));
});

test("claimOnce swallows a fetchCycleTodos failure without throwing or moving", async () => {
  const { deps, moved, logs } = claimDeps({
    fetchCycleTodos: async () => {
      throw new Error("todos 503");
    },
  });
  await claimOnce(freshClaimState(), deps); // must not throw
  assert.equal(moved.length, 0);
  assert.ok(logs.some((l) => /todos 503/.test(l)));
});

function reconcileDeps(overrides: Partial<ReconcileDeps> = {}): {
  deps: ReconcileDeps;
  movedBack: string[];
  unlatched: string[];
  logs: string[];
} {
  const movedBack: string[] = [];
  const unlatched: string[] = [];
  const logs: string[] = [];
  const deps: ReconcileDeps = {
    fetchInProgress: async () => [],
    fetchMergedIdentifiers: async () => new Set<string>(),
    moveToTodo: async (id) => void movedBack.push(id),
    unlatchDeploy: (id) => void unlatched.push(id),
    log: (msg) => void logs.push(msg),
    ...overrides,
  };
  return { deps, movedBack, unlatched, logs };
}

test("reconcile moves a blocked In-Progress ticket back and unlatches, never tearing down", async () => {
  const { deps, movedBack, unlatched, logs } = reconcileDeps({
    fetchInProgress: async () => [
      { id: "i-5", identifier: "ENG-5", title: "t", blockedBy: ["ENG-4"] },
    ],
    fetchMergedIdentifiers: async () => new Set<string>(),
  });
  await reconcileBlockedInProgress(deps);
  assert.deepEqual(movedBack, ["i-5"]);
  assert.deepEqual(unlatched, ["i-5"]);
  assert.ok(logs.some((l) => l.includes("moved ENG-5 back to Todo") && l.includes("ENG-4")));
});

test("reconcile leaves unblocked and no-blocker tickets alone", async () => {
  const { deps, movedBack } = reconcileDeps({
    fetchInProgress: async () => [
      { id: "i-5", identifier: "ENG-5", title: "t", blockedBy: ["ENG-4"] },
      { id: "i-6", identifier: "ENG-6", title: "t", blockedBy: [] },
    ],
    fetchMergedIdentifiers: async () => new Set(["ENG-4"]),
  });
  await reconcileBlockedInProgress(deps);
  assert.equal(movedBack.length, 0);
});

test("reconcile swallows a fetch failure without throwing", async () => {
  const { deps, movedBack, logs } = reconcileDeps({
    fetchInProgress: async () => {
      throw new Error("boom");
    },
  });
  await reconcileBlockedInProgress(deps); // must not throw
  assert.equal(movedBack.length, 0);
  assert.ok(logs.some((l) => l.includes("reconcile failed")));
});

test("reconcile does not unlatch when the move fails", async () => {
  const { deps, unlatched, logs } = reconcileDeps({
    fetchInProgress: async () => [
      { id: "i-5", identifier: "ENG-5", title: "t", blockedBy: ["ENG-4"] },
    ],
    moveToTodo: async () => {
      throw new Error("move boom");
    },
  });
  await reconcileBlockedInProgress(deps);
  assert.equal(unlatched.length, 0);
  assert.ok(logs.some((l) => l.includes("failed to move ENG-5 back")));
});

test("returnKeyBindArgs targets the board pane so the window and pane are selected too", () => {
  assert.deepEqual(returnKeyBindArgs("%36", "Y"), [
    "bind-key", "-T", "prefix", "Y", "switch-client", "-t", "%36",
  ]);
});

test("returnKeyBindArgs carries a custom key through unchanged", () => {
  assert.deepEqual(returnKeyBindArgs("%7", "F12"), [
    "bind-key", "-T", "prefix", "F12", "switch-client", "-t", "%7",
  ]);
});

test("currentTmuxPane is the pane id when under tmux", () => {
  const prevTmux = process.env.TMUX;
  const prevPane = process.env.TMUX_PANE;
  process.env.TMUX = "/tmp/tmux-1000/default,123,0";
  process.env.TMUX_PANE = "%36";
  try {
    assert.equal(currentTmuxPane(), "%36");
  } finally {
    if (prevTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = prevTmux;
    if (prevPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = prevPane;
  }
});

test("currentTmuxPane is null outside tmux or without a pane id", () => {
  const prevTmux = process.env.TMUX;
  const prevPane = process.env.TMUX_PANE;
  try {
    delete process.env.TMUX;
    process.env.TMUX_PANE = "%36";
    assert.equal(currentTmuxPane(), null);
    process.env.TMUX = "/tmp/tmux-1000/default,123,0";
    delete process.env.TMUX_PANE;
    assert.equal(currentTmuxPane(), null);
  } finally {
    if (prevTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = prevTmux;
    if (prevPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = prevPane;
  }
});

test("returnKeyUnbindArgs removes the binding from the prefix table", () => {
  assert.deepEqual(returnKeyUnbindArgs("Y"), ["unbind-key", "-T", "prefix", "Y"]);
});

test("bindReturnKey returns false when TMUX is unset, without shelling out", () => {
  const prevTmux = process.env.TMUX;
  delete process.env.TMUX;
  try {
    assert.equal(bindReturnKey("%36", "Y"), false);
  } finally {
    if (prevTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = prevTmux;
  }
});

test("unbindReturnKey is a no-op when TMUX is unset, without shelling out", () => {
  const prevTmux = process.env.TMUX;
  delete process.env.TMUX;
  try {
    assert.equal(unbindReturnKey("Y"), undefined);
  } finally {
    if (prevTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = prevTmux;
  }
});

test("claimOnce skips the scan and claims when the marker comment is already present", async () => {
  let scanned = false;
  const { scan, relations } = scanDeps({
    fetchMarker: async () => "<!-- yimbot-dependency-scan --> already done",
    scan: async () => {
      scanned = true;
      return ["ENG-1319"];
    },
  });
  const { deps, moved } = claimDeps({
    fetchCycleTodos: async () => [cycleTodo({ id: "1", priority: 1, description: "blocked by ENG-1319" })],
    dependencyScan: scan,
  });
  await claimOnce(freshClaimState(), deps);
  assert.equal(scanned, false, "a scanned ticket must never be re-adjudicated");
  assert.deepEqual(relations, []);
  assert.equal(moved.length, 1);
});

test("claimOnce does not fetch the marker when the description has no candidate lines", async () => {
  let markerFetched = false;
  const { scan } = scanDeps({
    fetchMarker: async () => {
      markerFetched = true;
      return "";
    },
  });
  const { deps, moved } = claimDeps({
    fetchCycleTodos: async () => [cycleTodo({ id: "1", priority: 1, description: "Just a plain description." })],
    dependencyScan: scan,
  });
  await claimOnce(freshClaimState(), deps);
  assert.equal(markerFetched, false, "no candidate lines means nothing to scan, so skip the network call");
  assert.equal(moved.length, 1);
});

test("claimOnce claims when the scan finds no blockers", async () => {
  const { scan, relations, markers } = scanDeps({ scan: async () => [] });
  const { deps, moved } = claimDeps({
    fetchCycleTodos: async () => [cycleTodo({ id: "1", priority: 1, description: "Follow-up to ENG-1434." })],
    dependencyScan: scan,
  });
  await claimOnce(freshClaimState(), deps);
  assert.deepEqual(relations, []);
  assert.deepEqual(markers, []);
  assert.equal(moved.length, 1);
});

test("claimOnce writes the relation and the marker and does not claim when blockers are found", async () => {
  const { scan, relations, markers } = scanDeps();
  const { deps, moved, logs } = claimDeps({
    fetchCycleTodos: async () => [
      cycleTodo({ id: "1", priority: 1, identifier: "ENG-1320", description: "Must land after ENG-1319." }),
    ],
    dependencyScan: scan,
  });
  await claimOnce(freshClaimState(), deps);
  assert.deepEqual(relations, [["uuid-ENG-1319", "1"]], "blocker uuid first, blocked issue id second");
  assert.equal(markers.length, 1);
  assert.equal(markers[0][0], "1");
  assert.ok(markers[0][1].includes("ENG-1319"));
  assert.equal(moved.length, 0, "a ticket just found to be blocked must not be claimed");
  assert.ok(logs.some((l) => l.includes("ENG-1320") && l.includes("ENG-1319")));
});

test("claimOnce cites only the lines for blockers actually recorded in the marker", async () => {
  const { scan, markers } = scanDeps();
  const { deps, moved } = claimDeps({
    fetchCycleTodos: async () => [
      cycleTodo({
        id: "1",
        priority: 1,
        identifier: "ENG-1320",
        description: "Blocks ENG-1132 downstream.\nBlocked by ENG-1319 first.",
      }),
    ],
    dependencyScan: scan,
  });
  await claimOnce(freshClaimState(), deps);
  assert.equal(moved.length, 0);
  assert.equal(markers.length, 1);
  assert.ok(markers[0][1].includes("ENG-1319"), "must cite the accepted blocker's line");
  assert.ok(!markers[0][1].includes("ENG-1132"), "must not cite the rejected line as a source");
});

test("claimOnce falls open and claims when the scan itself errors", async () => {
  const { scan, relations } = scanDeps({
    scan: async () => {
      throw new Error("claude exploded");
    },
  });
  const { deps, moved, logs } = claimDeps({
    fetchCycleTodos: async () => [cycleTodo({ id: "1", priority: 1, description: "blocked by ENG-1319" })],
    dependencyScan: scan,
  });
  await claimOnce(freshClaimState(), deps);
  assert.deepEqual(relations, []);
  assert.equal(moved.length, 1, "a broken scanner must never halt the claim step");
  assert.ok(logs.some((l) => /dependency scan failed/.test(l)));
});

test("claimOnce falls open and claims when every blocker fails to resolve", async () => {
  const { scan, relations } = scanDeps({
    resolveId: async () => {
      throw new Error("no such issue");
    },
  });
  const { deps, moved, logs } = claimDeps({
    fetchCycleTodos: async () => [cycleTodo({ id: "1", priority: 1, description: "blocked by RFC-005" })],
    dependencyScan: scan,
  });
  await claimOnce(freshClaimState(), deps);
  assert.deepEqual(relations, []);
  assert.equal(moved.length, 1);
  assert.ok(logs.some((l) => /did not resolve/.test(l)));
});

test("claimOnce fails closed and does not claim when the relation write errors", async () => {
  const { scan } = scanDeps({
    createRelation: async () => {
      throw new Error("linear 500");
    },
  });
  const { deps, moved, logs } = claimDeps({
    fetchCycleTodos: async () => [cycleTodo({ id: "1", priority: 1, description: "blocked by ENG-1319" })],
    dependencyScan: scan,
  });
  await claimOnce(freshClaimState(), deps);
  assert.equal(moved.length, 0, "the ticket is known blocked, so claiming anyway is the bug this prevents");
  assert.ok(logs.some((l) => /failed to record blockers/.test(l)));
});

test("claimOnce latches a write-failed ticket into the skip set so a later tick claims the next one instead", async () => {
  const state = freshClaimState();
  let scansOfTicket1 = 0;
  const { scan } = scanDeps({
    scan: async (identifier) => {
      if (identifier === "ENG-1320") scansOfTicket1++;
      return identifier === "ENG-1320" ? ["ENG-1319"] : [];
    },
    createRelation: async () => {
      throw new Error("linear 500");
    },
  });
  const todos = [
    cycleTodo({ id: "1", priority: 1, identifier: "ENG-1320", description: "Must land after ENG-1319." }),
    cycleTodo({ id: "2", priority: 2, identifier: "ENG-1321" }),
  ];
  const { deps, moved } = claimDeps({
    fetchCycleTodos: async () => todos,
    dependencyScan: scan,
  });

  await claimOnce(state, deps);
  assert.equal(moved.length, 0, "write failure fails closed on tick 1");
  assert.equal(scansOfTicket1, 1);

  await claimOnce(state, deps);
  assert.deepEqual(moved.map((i) => i.id), ["2"], "tick 2 picks the next-priority ticket instead of stalling");
  assert.equal(scansOfTicket1, 1, "the write-failed ticket must not be rescanned every tick");

  await claimOnce(state, deps);
  assert.ok(!moved.some((i) => i.id === "1"), "the write-failed ticket must never be claimed");
});

test("claimOnce claims normally when no dependency scan is configured", async () => {
  const { deps, moved } = claimDeps({
    fetchCycleTodos: async () => [cycleTodo({ id: "1", priority: 1, description: "blocked by ENG-1319" })],
  });
  await claimOnce(freshClaimState(), deps);
  assert.equal(moved.length, 1);
});
