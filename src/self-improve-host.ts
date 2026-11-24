import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { YimbotEvent } from "./events.ts";
import type { SelfImproveJob } from "./self-improve-jobs.ts";

export const selfImproveScriptPath = join(homedir(), "self-improve-session.sh");

const BRANCH_PREFIX = "chore/self-improve-";

export function yimbotRepoRoot(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}

export function selfImproveBranch(jobId: string, now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${BRANCH_PREFIX}${jobId}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// The board row for a finished run. It carries no PR number on purpose: the TUI
// resolves a row's PR against the codebase repo, and this PR lives in the yimbot repo.
export function selfImproveDoneEvent(job: SelfImproveJob, pr: number | null): Omit<YimbotEvent, "ts"> {
  return {
    kind: "self_improve_done",
    key: `self-improve:${job.id}`,
    label: job.label,
    title: pr === null ? "nothing to change" : `PR #${pr}`,
  };
}

export function selfImproveSessionArgs(jobId: string, branch: string): string[] {
  return [selfImproveScriptPath, jobId, branch];
}

// Detached and fire-and-forget like the other spawners; a failed launch is
// logged and the session-gone sweep clears the run.
export function spawnSelfImproveSession(jobId: string, branch: string): void {
  const proc = spawn("bash", selfImproveSessionArgs(jobId, branch), { detached: true, stdio: "ignore" });
  proc.unref();
  proc.once("error", (err) => console.error(`[self-improve] launching '${jobId}' failed: ${err}`));
  proc.once("exit", (code) => {
    if (code !== 0) console.error(`[self-improve] self-improve-session.sh for '${jobId}' exited ${code}`);
  });
}

export function existingSelfImproveBranch(repoRoot: string, jobId: string): string | null {
  let out: string;
  try {
    out = execFileSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  } catch {
    return null;
  }
  let path = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
    else if (line.startsWith("branch refs/heads/") && basename(path) === `self-improve-${jobId}`) {
      return line.slice("branch refs/heads/".length);
    }
  }
  return null;
}

function worktreePathForBranch(repoRoot: string, branch: string): string | null {
  const out = execFileSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  let path: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}

// Only ever touches chore/self-improve-* branches: --force and branch -D are
// destructive, so anything else is refused outright.
export function removeSelfImproveWorktree(repoRoot: string, branch: string, deleteBranch: boolean): void {
  if (!branch.startsWith(BRANCH_PREFIX)) throw new Error(`refusing to remove a branch outside ${BRANCH_PREFIX}*: ${branch}`);
  const path = worktreePathForBranch(repoRoot, branch);
  if (path) execFileSync("git", ["-C", repoRoot, "worktree", "remove", "--force", path], { stdio: "ignore" });
  if (deleteBranch) {
    try {
      execFileSync("git", ["-C", repoRoot, "branch", "-D", branch], { stdio: "ignore" });
    } catch {
      // Already gone: nothing to delete.
    }
  }
}
