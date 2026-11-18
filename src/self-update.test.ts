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
  writeFileSync(join(dir, "self-update.lock"), dead);
  assert.equal(await withUpdateLock(dir, async () => "ran"), "ran");
});
