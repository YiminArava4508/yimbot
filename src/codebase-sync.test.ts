import assert from "node:assert/strict";
import { test } from "node:test";
import { gitSyncArgs, resolveDefaultBranch } from "./codebase-sync.ts";

test("on the main branch: fast-forward pull from origin", () => {
  assert.deepEqual(gitSyncArgs("main", "main"), [
    "pull",
    "--ff-only",
    "origin",
    "main",
  ]);
});

test("on a feature branch: fetch main into main without switching", () => {
  assert.deepEqual(gitSyncArgs("eng-42-thing", "main"), [
    "fetch",
    "origin",
    "main:main",
  ]);
});

test("detached HEAD is treated as not-on-main", () => {
  assert.deepEqual(gitSyncArgs("HEAD", "main"), [
    "fetch",
    "origin",
    "main:main",
  ]);
});

test("resolveDefaultBranch: DEFAULT_BRANCH override wins without touching git", async () => {
  process.env.DEFAULT_BRANCH = "develop";
  try {
    const branch = await resolveDefaultBranch("/repo", async () => {
      throw new Error("git should not be called when the override is set");
    });
    assert.equal(branch, "develop");
  } finally {
    delete process.env.DEFAULT_BRANCH;
  }
});

test("resolveDefaultBranch: reads origin/HEAD when no override", async () => {
  delete process.env.DEFAULT_BRANCH;
  const branch = await resolveDefaultBranch("/repo", async () => "origin/master\n");
  assert.equal(branch, "master");
});

test("resolveDefaultBranch: repairs origin/HEAD from the remote then re-reads", async () => {
  delete process.env.DEFAULT_BRANCH;
  const seen: string[] = [];
  const branch = await resolveDefaultBranch("/repo", async (args) => {
    seen.push(args[0]);
    if (args[0] === "symbolic-ref") {
      if (seen.filter((c) => c === "symbolic-ref").length === 1) {
        throw new Error("origin/HEAD not set");
      }
      return "origin/master\n";
    }
    return ""; // remote set-head --auto
  });
  assert.equal(branch, "master");
  assert.deepEqual(seen, ["symbolic-ref", "remote", "symbolic-ref"]);
});

test("resolveDefaultBranch: falls back to main when detection fails", async () => {
  delete process.env.DEFAULT_BRANCH;
  const branch = await resolveDefaultBranch("/repo", async () => {
    throw new Error("no origin/HEAD");
  });
  assert.equal(branch, "main");
});
