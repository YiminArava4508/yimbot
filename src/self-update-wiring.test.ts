// src/self-update-wiring.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./test-temp.ts";
import type { GitProbe, PrepDeps } from "./self-update.ts";
import { SAFE_CHECK_MS, startSelfUpdate } from "./self-update-wiring.ts";

const BOOT = "aaaaaaa1111111";
const NEXT = "bbbbbbb2222222";

type Repo = { branch: string; head: string; origin: string; clean: boolean };

function fakeGit(repo: Repo): GitProbe {
  return {
    async fetch() {},
    branch: async () => repo.branch,
    head: async () => repo.head,
    originHead: async () => repo.origin,
    isClean: async () => repo.clean,
    isAncestor: async () => false,
    async pullFfOnly() {},
    changedFiles: async () => [],
  };
}

function fakePrep(): PrepDeps & { typechecks: number } {
  const prep = {
    typechecks: 0,
    async install() {},
    async typecheck() {
      prep.typechecks++;
      return true;
    },
  };
  return prep;
}

function fakeTimers() {
  const pending: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  return {
    setTimer(fn: () => void, ms: number) {
      const t = { fn, ms, cleared: false };
      pending.push(t);
      return { clear: () => void (t.cleared = true) };
    },
    fire(ms: number) {
      const due = pending.filter((t) => t.ms === ms && !t.cleared);
      for (const t of due) {
        t.cleared = true;
        t.fn();
      }
      return due.length;
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

function setup(over: { env?: NodeJS.ProcessEnv; repo?: Partial<Repo>; safe?: boolean } = {}) {
  const repo: Repo = { branch: "master", head: NEXT, origin: NEXT, clean: true, ...over.repo };
  const gitDir = tempDir("wiring-");
  const prep = fakePrep();
  const timers = fakeTimers();
  const logs: string[] = [];
  const ctl = { safe: over.safe ?? true, restarts: 0 };
  const handle = startSelfUpdate({
    repoDir: "/unused",
    env: over.env ?? {},
    isSafe: () => ctl.safe,
    restart: () => void ctl.restarts++,
    log: (m) => logs.push(m),
    deps: { git: fakeGit(repo), prep, gitDir: () => gitDir, headSha: () => BOOT, setTimer: timers.setTimer },
  });
  return { repo, gitDir, prep, timers, logs, ctl, handle };
}

test("disabled returns null", () => {
  const { handle } = setup({ env: { SELF_UPDATE: "off" } });
  assert.equal(handle, null);
});

test("exposes the boot sha and starts with no state", () => {
  const { handle } = setup({ safe: false });
  assert.equal(handle?.bootSha, BOOT);
  assert.equal(handle?.state(), null);
  handle?.stop();
});

test("a ready state is reported through state()", async () => {
  const { handle, logs } = setup({ safe: false });
  await flush();
  assert.deepEqual(handle?.state(), { kind: "ready", target: NEXT });
  assert.ok(logs.some((l) => l.includes("ready") && l.includes(NEXT.slice(0, 7))));
  handle?.stop();
});

test("seeds the skip set from YIMBOT_SKIP_SHA", async () => {
  const { handle, prep } = setup({ env: { YIMBOT_SKIP_SHA: NEXT } });
  await flush();
  assert.deepEqual(handle?.state(), { kind: "blocked", reason: `typecheck fails at ${NEXT.slice(0, 7)}` });
  assert.equal(prep.typechecks, 0);
  handle?.stop();
});

test("restarts only once isSafe turns true", async () => {
  const { handle, timers, ctl } = setup({ safe: false });
  await flush();
  assert.equal(timers.fire(SAFE_CHECK_MS), 1);
  await flush();
  assert.equal(ctl.restarts, 0);
  ctl.safe = true;
  assert.equal(timers.fire(SAFE_CHECK_MS), 1);
  await flush();
  assert.equal(ctl.restarts, 1);
  handle?.stop();
});

for (const [name, change] of [
  ["branch moved off master", { branch: "feature" }],
  ["tree went dirty", { clean: false }],
  ["head moved past the target", { head: "ccccccc3333333" }],
] as const) {
  test(`stillValid blocks the restart when the ${name}`, async () => {
    const { handle, timers, ctl, repo } = setup({ safe: false });
    await flush();
    Object.assign(repo, change);
    ctl.safe = true;
    timers.fire(SAFE_CHECK_MS);
    await flush();
    assert.equal(ctl.restarts, 0);
    assert.deepEqual(handle?.state(), { kind: "blocked", reason: "dirty tree" });
    handle?.stop();
  });
}

test("logs each state change", async () => {
  const { handle, timers, logs, repo } = setup({ safe: false });
  await flush();
  repo.branch = "feature";
  timers.fire(5 * 60_000);
  await flush();
  assert.deepEqual(handle?.state(), { kind: "blocked", reason: "not on master" });
  assert.equal(logs.filter((l) => l.startsWith("[self-update] state")).length, 2);
  assert.ok(logs.some((l) => l.includes("not on master")));
  handle?.stop();
});

test("a lock held by another live pid keeps the previous state", async () => {
  const { handle, timers, logs, repo, gitDir } = setup({ safe: false, repo: { branch: "feature" } });
  await flush();
  assert.deepEqual(handle?.state(), { kind: "blocked", reason: "not on master" });
  writeFileSync(join(gitDir, "yimbot-update.lock"), String(process.ppid));
  repo.branch = "master";
  timers.fire(5 * 60_000);
  await flush();
  assert.deepEqual(handle?.state(), { kind: "blocked", reason: "not on master" });
  assert.ok(logs.some((l) => l.includes("lock")));
  handle?.stop();
});

test("a failing check is logged and keeps the previous state", async () => {
  const { handle, timers, logs, repo } = setup({ safe: false, repo: { branch: "feature" } });
  await flush();
  repo.branch = "master";
  Object.defineProperty(repo, "origin", {
    get() {
      throw new Error("boom");
    },
  });
  timers.fire(5 * 60_000);
  await flush();
  assert.deepEqual(handle?.state(), { kind: "blocked", reason: "not on master" });
  assert.ok(logs.some((l) => l.includes("check failed") && l.includes("boom")));
  handle?.stop();
});

test("stop clears the timers", async () => {
  const { handle, timers } = setup({ safe: false });
  await flush();
  handle?.stop();
  assert.equal(timers.fire(SAFE_CHECK_MS), 0);
  assert.equal(timers.fire(5 * 60_000), 0);
});

test("an unreadable boot sha disables self-update instead of crashing boot", () => {
  const logs: string[] = [];
  const handle = startSelfUpdate({
    repoDir: "/unused",
    env: {},
    isSafe: () => true,
    restart: () => {},
    log: (m) => logs.push(m),
    deps: {
      headSha: () => {
        throw new Error("not a git repository");
      },
    },
  });
  assert.equal(handle, null);
  assert.ok(logs.some((l) => l.includes("not a git repository")));
});
