// src/self-update.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./test-temp.ts";
import {
  checkForUpdate,
  gitProbe,
  pollIntervalMs,
  selfUpdateEnabled,
  startSelfUpdater,
  type SelfUpdaterDeps,
  type UpdateState,
  withUpdateLock,
  type GitProbe,
  type PrepDeps,
} from "./self-update.ts";

const BOOT = "aaaaaaa1111111";
const ORIGIN = "bbbbbbb2222222";

function fakeGit(over: Partial<{
  branch: string;
  head: string;
  originHead: string;
  clean: boolean;
  ancestors: Array<[string, string]>;
  changed: string[];
  fetchFails: boolean;
  headAfterPull: string;
}> = {}): GitProbe & { calls: string[] } {
  const o = { branch: "master", head: BOOT, originHead: BOOT, clean: true, ancestors: [], changed: [], ...over };
  const calls: string[] = [];
  let pulled = false;
  return {
    calls,
    async fetch() {
      calls.push("fetch");
      if (o.fetchFails) throw new Error("offline");
    },
    async branch() {
      return o.branch;
    },
    async head() {
      return pulled ? (o.headAfterPull ?? o.originHead) : o.head;
    },
    async originHead() {
      return o.originHead;
    },
    async isClean() {
      return o.clean;
    },
    async isAncestor(a, b) {
      return o.ancestors.some(([x, y]) => x === a && y === b);
    },
    async pullFfOnly() {
      calls.push("pull");
      pulled = true;
    },
    async changedFiles() {
      return o.changed;
    },
  };
}

function fakePrep(typecheckOk = true): PrepDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async install() {
      calls.push("install");
    },
    async typecheck() {
      calls.push("typecheck");
      return typecheckOk;
    },
  };
}

test("current when head and origin equal boot", async () => {
  const git = fakeGit();
  const state = await checkForUpdate(BOOT, git, fakePrep(), new Set());
  assert.deepEqual(state, { kind: "current" });
  assert.ok(!git.calls.includes("pull"));
});

test("blocked when not on master", async () => {
  const state = await checkForUpdate(BOOT, fakeGit({ branch: "feat/x" }), fakePrep(), new Set());
  assert.deepEqual(state, { kind: "blocked", reason: "not on master" });
});

test("blocked when tree dirty", async () => {
  const git = fakeGit({ clean: false, originHead: ORIGIN });
  const state = await checkForUpdate(BOOT, git, fakePrep(), new Set());
  assert.deepEqual(state, { kind: "blocked", reason: "dirty tree" });
  assert.ok(!git.calls.includes("pull"));
});

test("pulls when origin is ahead", async () => {
  const git = fakeGit({ originHead: ORIGIN, ancestors: [[BOOT, ORIGIN]] });
  const state = await checkForUpdate(BOOT, git, fakePrep(), new Set());
  assert.deepEqual(state, { kind: "ready", target: ORIGIN });
  assert.equal(git.calls.filter((c) => c === "pull").length, 1);
});

test("local commit ahead of origin is ready without pulling", async () => {
  const head = "ccccccc3333333";
  const git = fakeGit({ head, originHead: BOOT, ancestors: [[BOOT, head]] });
  const state = await checkForUpdate(BOOT, git, fakePrep(), new Set());
  assert.deepEqual(state, { kind: "ready", target: head });
  assert.ok(!git.calls.includes("pull"));
});

test("blocked when diverged", async () => {
  const git = fakeGit({ head: "ccccccc3333333", originHead: ORIGIN });
  const state = await checkForUpdate(BOOT, git, fakePrep(), new Set());
  assert.deepEqual(state, { kind: "blocked", reason: "diverged" });
});

test("installs only when pnpm-lock.yaml changed", async () => {
  const withLock = fakePrep();
  await checkForUpdate(
    BOOT,
    fakeGit({ originHead: ORIGIN, ancestors: [[BOOT, ORIGIN]], changed: ["pnpm-lock.yaml"] }),
    withLock,
    new Set(),
  );
  assert.ok(withLock.calls.includes("install"));

  const withoutLock = fakePrep();
  await checkForUpdate(
    BOOT,
    fakeGit({ originHead: ORIGIN, ancestors: [[BOOT, ORIGIN]], changed: ["src/a.ts"] }),
    withoutLock,
    new Set(),
  );
  assert.ok(!withoutLock.calls.includes("install"));
});

test("typecheck failure blocks and skips the sha", async () => {
  const skipped = new Set<string>();
  const git = fakeGit({ originHead: ORIGIN, ancestors: [[BOOT, ORIGIN]] });
  const state = await checkForUpdate(BOOT, git, fakePrep(false), skipped);
  assert.deepEqual(state, { kind: "blocked", reason: `typecheck fails at ${ORIGIN.slice(0, 7)}` });
  assert.ok(skipped.has(ORIGIN));
});

test("skipped sha is blocked, not ready", async () => {
  const prep = fakePrep();
  const git = fakeGit({ originHead: ORIGIN, ancestors: [[BOOT, ORIGIN]] });
  const state = await checkForUpdate(BOOT, git, prep, new Set([ORIGIN]));
  assert.equal(state.kind, "blocked");
  assert.ok(!prep.calls.includes("typecheck"));
});

test("fetch failure keeps state quiet", async () => {
  const state = await checkForUpdate(BOOT, fakeGit({ fetchFails: true }), fakePrep(), new Set());
  assert.deepEqual(state, { kind: "blocked", reason: "fetch failed" });
});

test("gitProbe isClean ignores ignored files", async () => {
  const dir = tempDir("self-update-git-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(dir, ".gitignore"), "*.log\n");
  git("add", ".gitignore");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(dir, "x.log"), "noise");
  const probe = gitProbe(dir);
  assert.equal(await probe.isClean(), true);
  writeFileSync(join(dir, "y.ts"), "export {};\n");
  assert.equal(await probe.isClean(), false);
});

test("withUpdateLock returns null while a live pid holds the lock", async () => {
  const dir = tempDir("self-update-lock-");
  const inner = await withUpdateLock(dir, async () => withUpdateLock(dir, async () => "nested"));
  assert.equal(inner, null);
});

test("withUpdateLock reclaims a lock left by a dead pid", async () => {
  const dir = tempDir("self-update-lock-");
  const dead = execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).toString();
  writeFileSync(join(dir, "yimbot-update.lock"), dead);
  assert.equal(await withUpdateLock(dir, async () => "ran"), "ran");
});

function fakeUpdater(over: Partial<SelfUpdaterDeps> & { states?: UpdateState[] } = {}) {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const seen: UpdateState[] = [];
  const log = { checks: 0, restarts: 0 };
  const states = over.states ?? [{ kind: "current" }];
  const deps: SelfUpdaterDeps = {
    async check() {
      const s = states[Math.min(log.checks, states.length - 1)];
      log.checks++;
      return s;
    },
    isSafe: () => true,
    stillValid: async () => true,
    restart: () => {
      log.restarts++;
    },
    onState: (s) => seen.push(s),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return { clear: () => (t.cleared = true) };
    },
    ...over,
  };
  const flush = () => new Promise((r) => setImmediate(r));
  const fire = async (ms: number) => {
    const t = timers.find((x) => x.ms === ms && !x.cleared);
    assert.ok(t, `no active timer for ${ms}`);
    t.cleared = true;
    t.fn();
    await flush();
  };
  const opts = { pollMs: 300_000, safeCheckMs: 10_000 };
  return { deps, timers, seen, log, fire, flush, opts };
}

const READY: UpdateState = { kind: "ready", target: ORIGIN };

test("checks once at start and every pollMs", async () => {
  const f = fakeUpdater();
  const stop = startSelfUpdater(f.deps, f.opts);
  await f.flush();
  assert.equal(f.log.checks, 1);
  await f.fire(300_000);
  assert.equal(f.log.checks, 2);
  await f.fire(300_000);
  assert.equal(f.log.checks, 3);
  stop();
});

test("restarts on the first safe tick when ready", async () => {
  const f = fakeUpdater({ states: [READY] });
  startSelfUpdater(f.deps, f.opts);
  await f.flush();
  assert.equal(f.log.restarts, 0);
  await f.fire(10_000);
  assert.equal(f.log.restarts, 1);
});

test("waits while unsafe and restarts once safe", async () => {
  let safe = false;
  const f = fakeUpdater({ states: [READY], isSafe: () => safe });
  startSelfUpdater(f.deps, f.opts);
  await f.flush();
  await f.fire(10_000);
  await f.fire(10_000);
  assert.equal(f.log.restarts, 0);
  safe = true;
  await f.fire(10_000);
  assert.equal(f.log.restarts, 1);
});

test("does not restart when unsafe at the restart moment", async () => {
  const answers = [true, false];
  const f = fakeUpdater({ states: [READY], isSafe: () => answers.shift() ?? true });
  startSelfUpdater(f.deps, f.opts);
  await f.flush();
  await f.fire(10_000);
  assert.equal(f.log.restarts, 0);
  await f.fire(10_000);
  assert.equal(f.log.restarts, 1);
});

test("does not restart when stillValid is false", async () => {
  const f = fakeUpdater({ states: [READY], stillValid: async () => false });
  startSelfUpdater(f.deps, f.opts);
  await f.flush();
  await f.fire(10_000);
  assert.equal(f.log.restarts, 0);
  assert.deepEqual(f.seen.at(-1), { kind: "blocked", reason: "dirty tree" });
});

test("onState fires on every state change, not on repeats", async () => {
  const blockedState: UpdateState = { kind: "blocked", reason: "dirty tree" };
  const f = fakeUpdater({ states: [{ kind: "current" }, { kind: "current" }, blockedState, blockedState] });
  startSelfUpdater(f.deps, f.opts);
  await f.flush();
  await f.fire(300_000);
  await f.fire(300_000);
  await f.fire(300_000);
  assert.deepEqual(f.seen, [{ kind: "current" }, blockedState]);
});

test("never runs two checks at once", async () => {
  let release: (s: UpdateState) => void = () => {};
  let calls = 0;
  const f = fakeUpdater({
    check: () => {
      calls++;
      return new Promise<UpdateState>((r) => (release = r));
    },
  });
  startSelfUpdater(f.deps, f.opts);
  await f.flush();
  await f.fire(300_000);
  assert.equal(calls, 1);
  release({ kind: "current" });
  await f.flush();
});

test("a rejected check keeps polling and the previous state", async () => {
  let n = 0;
  const f = fakeUpdater({
    check: async () => {
      n++;
      if (n === 2) throw new Error("pnpm install failed");
      return { kind: "current" };
    },
  });
  startSelfUpdater(f.deps, f.opts);
  await f.flush();
  await f.fire(300_000);
  await f.fire(300_000);
  assert.equal(n, 3);
  assert.deepEqual(f.seen, [{ kind: "current" }]);
});

test("stop clears the timers", async () => {
  const f = fakeUpdater({ states: [READY] });
  const stop = startSelfUpdater(f.deps, f.opts);
  await f.flush();
  stop();
  assert.ok(f.timers.every((t) => t.cleared || t.ms === 0));
  assert.equal(f.timers.filter((t) => !t.cleared).length, 0);
});

test("selfUpdateEnabled and pollIntervalMs read the env", () => {
  assert.equal(selfUpdateEnabled({}), true);
  assert.equal(selfUpdateEnabled({ SELF_UPDATE: "off" }), false);
  assert.equal(selfUpdateEnabled({ SELF_UPDATE: "FALSE" }), false);
  assert.equal(selfUpdateEnabled({ SELF_UPDATE: "0" }), false);
  assert.equal(selfUpdateEnabled({ SELF_UPDATE: "true" }), true);
  assert.equal(pollIntervalMs({}), 300_000);
  assert.equal(pollIntervalMs({ SELF_UPDATE_INTERVAL_MINUTES: "2" }), 120_000);
  assert.equal(pollIntervalMs({ SELF_UPDATE_INTERVAL_MINUTES: "junk" }), 300_000);
});
