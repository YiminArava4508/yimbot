import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAIN_BRANCH = "main";

export function gitSyncArgs(currentBranch: string, mainBranch: string): string[] {
  if (currentBranch === mainBranch) {
    return ["pull", "--ff-only", "origin", mainBranch];
  }
  return ["fetch", "origin", `${mainBranch}:${mainBranch}`];
}

async function currentBranchOf(codebasePath: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", codebasePath, "rev-parse", "--abbrev-ref", "HEAD"],
    { timeout: 10_000 },
  );
  return stdout.trim();
}

export async function pullCodebase(codebasePath: string): Promise<void> {
  try {
    const branch = await currentBranchOf(codebasePath);
    const args = gitSyncArgs(branch, MAIN_BRANCH);
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["-C", codebasePath, ...args],
      { timeout: 60_000 },
    );
    const where = branch === MAIN_BRANCH ? MAIN_BRANCH : `${MAIN_BRANCH} (on ${branch})`;
    console.log(`[sync] ${where}: ${stdout.trim() || "already up to date"}`);
    if (stderr.trim()) console.warn(`[sync] stderr: ${stderr.trim()}`);
  } catch (err) {
    const output = `${(err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }).stdout ?? ""} ${(err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? ""}`;
    if (output.includes("non-fast-forward") || output.includes("rejected")) {
      console.warn(`[sync] ${MAIN_BRANCH} has diverged from origin in ${codebasePath} — skipped (resolve manually)`);
    } else if (output.includes("CONFLICT") || output.includes("rebase")) {
      console.error(`[sync] merge conflict detected in ${codebasePath} — please resolve manually and run: git rebase --abort`);
    } else {
      console.warn(`[sync] failed: ${err}`);
    }
  }
}
