import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SyncStatus } from "./tui-review.ts";

const exec = promisify(execFile);

export function parseSyncStatus(porcelain: string, ahead: string, head: string): SyncStatus | null {
  const unpushed = Number.parseInt(ahead.trim(), 10);
  if (Number.isNaN(unpushed)) return null;
  return { dirty: porcelain.trim() !== "", unpushed, head: head.trim() };
}

// Unpushed means not on any remote branch, so a branch with no upstream (or one
// tracking master) still reports its local-only commits. Untracked files are
// skipped: the context scaffold lives in the worktree and is never a change.
export async function worktreeSyncStatus(cwd: string): Promise<SyncStatus | null> {
  try {
    const git = (...args: string[]) => exec("git", ["-C", cwd, ...args]);
    const [status, ahead, head] = await Promise.all([
      git("status", "--porcelain", "--untracked-files=no"),
      git("rev-list", "--count", "HEAD", "--not", "--remotes"),
      git("rev-parse", "HEAD"),
    ]);
    return parseSyncStatus(status.stdout, ahead.stdout, head.stdout);
  } catch {
    return null;
  }
}
