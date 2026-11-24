import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tempDir } from "./test-temp.ts";
import { existingSelfImproveBranch, removeSelfImproveWorktree, selfImproveBranch, selfImproveDoneEvent, selfImproveScriptPath, selfImproveSessionArgs } from "./self-improve-host.ts";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function repoWithWorktree(branch: string): { repo: string; wt: string } {
  const repo = tempDir("yimbot-si-repo-");
  git(repo, "init", "-q", "-b", "master");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  const wt = join(tempDir("yimbot-si-wt-"), "wt");
  git(repo, "worktree", "add", "-q", "-b", branch, wt);
  return { repo, wt };
}

const hasBranch = (repo: string, branch: string): boolean => git(repo, "branch", "--list", branch) !== "";

test("selfImproveScriptPath is ~/self-improve-session.sh", () => {
  assert.equal(selfImproveScriptPath, join(homedir(), "self-improve-session.sh"));
});

test("selfImproveSessionArgs builds the self-improve-session.sh argv", () => {
  assert.deepEqual(selfImproveSessionArgs("dead-code-scan", "chore/self-improve-dead-code-scan-2026-11-24"), [
    selfImproveScriptPath,
    "dead-code-scan",
    "chore/self-improve-dead-code-scan-2026-11-24",
  ]);
});

test("removeSelfImproveWorktree removes the worktree and keeps the branch for a PR", () => {
  const branch = "chore/self-improve-x-2026-11-24";
  const { repo, wt } = repoWithWorktree(branch);
  removeSelfImproveWorktree(repo, branch, false);
  assert.equal(existsSync(wt), false);
  assert.equal(hasBranch(repo, branch), true);
});

test("removeSelfImproveWorktree also deletes the branch when asked", () => {
  const branch = "chore/self-improve-x-2026-11-24";
  const { repo, wt } = repoWithWorktree(branch);
  removeSelfImproveWorktree(repo, branch, true);
  assert.equal(existsSync(wt), false);
  assert.equal(hasBranch(repo, branch), false);
});

test("removeSelfImproveWorktree removes a worktree holding uncommitted changes", () => {
  const branch = "chore/self-improve-x-2026-11-24";
  const { repo, wt } = repoWithWorktree(branch);
  execFileSync("bash", ["-c", "echo dirty > scratch.txt"], { cwd: wt });
  removeSelfImproveWorktree(repo, branch, true);
  assert.equal(existsSync(wt), false);
});

test("removeSelfImproveWorktree does not throw when no worktree has the branch", () => {
  const repo = tempDir("yimbot-si-repo-");
  git(repo, "init", "-q", "-b", "master");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  assert.doesNotThrow(() => removeSelfImproveWorktree(repo, "chore/self-improve-none-2026-11-24", true));
});

test("removeSelfImproveWorktree refuses a branch outside chore/self-improve-", () => {
  const { repo, wt } = repoWithWorktree("feature/keep-me");
  assert.throws(() => removeSelfImproveWorktree(repo, "feature/keep-me", true), /chore\/self-improve-/);
  assert.equal(existsSync(wt), true);
});

test("selfImproveBranch carries the job id and the local date", () => {
  assert.equal(
    selfImproveBranch("dead-code-scan", new Date(2026, 10, 4, 0, 30)),
    "chore/self-improve-dead-code-scan-2026-11-04",
  );
});

test("selfImproveDoneEvent never carries a PR number, so board keys cannot act on the wrong repo", () => {
  const job = { id: "a", skill: "a", settingKey: "K", cadence: "daily" as const, hour: 0, label: "dead code scan" };
  const withPr = selfImproveDoneEvent(job, 42);
  assert.equal(withPr.kind, "self_improve_done");
  assert.equal(withPr.key, "self-improve:a");
  assert.equal(withPr.title, "PR #42");
  assert.equal("pr" in withPr, false);
  assert.equal(selfImproveDoneEvent(job, null).title, "nothing to change");
});

test("existingSelfImproveBranch finds the branch of the job's worktree by directory name", () => {
  const repo = tempDir("yimbot-si-repo-");
  git(repo, "init", "-q", "-b", "master");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  const root = tempDir("yimbot-si-wt-");
  git(repo, "worktree", "add", "-q", "-b", "chore/self-improve-a-2026-11-23", join(root, "self-improve-a"));
  assert.equal(existingSelfImproveBranch(repo, "a"), "chore/self-improve-a-2026-11-23");
  assert.equal(existingSelfImproveBranch(repo, "b"), null);
});
