// flag-archive-check.ts - checks 2 and 3 of the prod flag-archive policy.
// Prints the JSON report and exits non-zero when any check fails or an input
// can't be read. See src/flag-archive.ts.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseArgs, runFlagArchiveCheck, type GitRunner } from "../src/flag-archive.ts";
import { ghRunner } from "../src/gh.ts";

const args = parseArgs(process.argv.slice(2));
if (!args) {
  console.error("Usage: flag-archive-check.sh <flag-key> [--gemini-dir <path>]");
  process.exit(2);
}
const geminiDir = args.geminiDir ?? process.env.GEMINI_DIR ?? join(homedir(), "Work", "gemini");
const quietHours = Number(process.env.FLAG_ARCHIVE_QUIET_HOURS) > 0 ? Number(process.env.FLAG_ARCHIVE_QUIET_HOURS) : 24;

const execFileAsync = promisify(execFile);
const git: GitRunner = async (gitArgs) => {
  try {
    const { stdout } = await execFileAsync("git", gitArgs, { cwd: geminiDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, stdout };
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return { code: typeof code === "number" ? code : 128, stdout: String((e as { stdout?: unknown }).stdout ?? "") };
  }
};

const report = await runFlagArchiveCheck({ key: args.key, gh: ghRunner(geminiDir), git });
console.log(JSON.stringify({ ...report, quietHours }, null, 2));
process.exit(report.pass ? 0 : 1);
