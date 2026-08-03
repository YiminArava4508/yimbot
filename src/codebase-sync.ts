import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function gitSyncArgs(currentBranch: string, mainBranch: string): string[] {
  if (currentBranch === mainBranch) {
    return ["pull", "--ff-only", "origin", mainBranch];
  }
  return ["fetch", "origin", `${mainBranch}:${mainBranch}`];
}

// Resolve a repo's default branch: honor DEFAULT_BRANCH, else read origin/HEAD
// (e.g. "origin/master" -> "master"), repairing it from the remote when unset,
// else fall back to "main". Mirrors new-session.sh's default_branch_of so the
// daemon and launcher agree. `run` is injected so the resolution logic is
// unit-testable without a real repo.
export async function resolveDefaultBranch(
  codebasePath: string,
  run: (args: string[]) => Promise<string> = async (args) =>
    (await execFileAsync("git", ["-C", codebasePath, ...args], { timeout: 10_000 }))
      .stdout,
): Promise<string> {
  const override = process.env.DEFAULT_BRANCH?.trim();
  if (override) return override;
  const readHead = async (): Promise<string> => {
    try {
      const ref = (await run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim();
      return ref.replace(/^origin\//, "");
    } catch {
      return "";
    }
  };
  let branch = await readHead();
  if (!branch) {
    await run(["remote", "set-head", "origin", "--auto"]).catch(() => "");
    branch = await readHead();
  }
  return branch || "main";
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
  const mainBranch = await resolveDefaultBranch(codebasePath);
  try {
    const branch = await currentBranchOf(codebasePath);
    const args = gitSyncArgs(branch, mainBranch);
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["-C", codebasePath, ...args],
      { timeout: 60_000 },
    );
    const where = branch === mainBranch ? mainBranch : `${mainBranch} (on ${branch})`;
    console.log(`[sync] ${where}: ${stdout.trim() || "already up to date"}`);
    if (stderr.trim()) console.warn(`[sync] stderr: ${stderr.trim()}`);
  } catch (err) {
    const output = `${(err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }).stdout ?? ""} ${(err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? ""}`;
    if (output.includes("non-fast-forward") || output.includes("rejected")) {
      console.warn(`[sync] ${mainBranch} has diverged from origin in ${codebasePath} — skipped (resolve manually)`);
    } else if (output.includes("CONFLICT") || output.includes("rebase")) {
      console.error(`[sync] merge conflict detected in ${codebasePath} — please resolve manually and run: git rebase --abort`);
    } else {
      console.warn(`[sync] failed: ${err}`);
    }
  }
}
