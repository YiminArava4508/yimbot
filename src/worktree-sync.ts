import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SyncStatus } from "./tui-review.ts";

const exec = promisify(execFile);

export function parseSyncStatus(porcelain: string, ahead: string): SyncStatus | null {
  const unpushed = Number.parseInt(ahead.trim(), 10);
  if (Number.isNaN(unpushed)) return null;
  return { dirty: porcelain.trim() !== "", unpushed };
}

export async function worktreeSyncStatus(cwd: string): Promise<SyncStatus | null> {
  try {
    const [status, ahead] = await Promise.all([
      exec("git", ["-C", cwd, "status", "--porcelain"]),
      exec("git", ["-C", cwd, "rev-list", "--count", "@{u}..HEAD"]),
    ]);
    return parseSyncStatus(status.stdout, ahead.stdout);
  } catch {
    return null;
  }
}
