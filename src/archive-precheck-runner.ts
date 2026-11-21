// src/archive-precheck-runner.ts
// Runs flag-archive checks 2 and 3 against the gemini checkout for the claim
// step's precheck (see claim-precheck.ts), the same way flag-archive-check.sh
// does, and boils the report down to pass plus the failing checks' details.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PrecheckResult } from "./claim-precheck.ts";
import { runFlagArchiveCheck, type GitRunner } from "./flag-archive.ts";
import { ghRunner } from "./gh.ts";

const execFileAsync = promisify(execFile);

function gitIn(dir: string): GitRunner {
  return async (args) => {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      return { code: 0, stdout };
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      return { code: typeof code === "number" ? code : 128, stdout: String((e as { stdout?: unknown }).stdout ?? "") };
    }
  };
}

export async function runArchivePrecheck(key: string, geminiDir: string): Promise<PrecheckResult> {
  const report = await runFlagArchiveCheck({ key, gh: ghRunner(geminiDir), git: gitIn(geminiDir) });
  if (report.pass) return { pass: true, detail: "reference checks pass" };
  const failed = report.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`);
  return { pass: false, detail: failed.join("; ").slice(0, 400) };
}
