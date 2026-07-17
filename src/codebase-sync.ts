import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function pullCodebase(codebasePath: string): Promise<void> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["-C", codebasePath, "pull", "--rebase", "origin", "main"],
      { timeout: 60_000 },
    );
    console.log(`[sync] ${stdout.trim() || "already up to date"}`);
    if (stderr.trim()) console.warn(`[sync] stderr: ${stderr.trim()}`);
  } catch (err) {
    const output = `${(err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }).stdout ?? ""} ${(err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? ""}`;
    if (output.includes("CONFLICT") || output.includes("rebase")) {
      console.error(`[sync] merge conflict detected in ${codebasePath} — please resolve manually and run: git rebase --abort`);
    } else {
      console.warn(`[sync] failed: ${err}`);
    }
  }
}
