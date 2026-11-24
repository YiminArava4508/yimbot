import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const selfImproveScriptPath = join(homedir(), "self-improve-session.sh");

const BRANCH_PREFIX = "chore/self-improve-";

export function yimbotRepoRoot(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}

export function selfImproveBranch(jobId: string, now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${BRANCH_PREFIX}${jobId}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
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
