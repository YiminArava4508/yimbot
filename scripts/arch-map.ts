// scripts/arch-map.ts
// Regenerates the reviewed codebase's architecture map. One headless call,
// standalone from index.ts: this script is spawned as its own process, so it
// carries its own copy of the same headless claude -p runner rather than
// importing index.ts's local closure.
import { execFile, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { archMapPath } from "../src/arch-map.ts";
import { mapPrompt, parseGeneratedMap, sourcePaths } from "../src/arch-generate.ts";

const execFileAsync = promisify(execFile);
const codebase = process.env.CODEBASE_PATH || join(homedir(), "Work/gemini");
const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: codebase, encoding: "utf8" }).trim();

// Same headless claude -p shape as index.ts's runHeadless: the given model
// env overrides, falling back to the judge's model knob.
const runHeadless = (model: string) => async (prompt: string) => {
  const args = ["-p", prompt];
  if (model) args.push("--model", model);
  const { stdout } = await execFileAsync("claude", args, {
    cwd: codebase,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
  });
  return stdout;
};

const paths = sourcePaths(git("ls-files").split("\n"));
if (paths.length === 0) {
  console.error(`[arch-map] no source files under ${codebase}`);
  process.exit(1);
}
const model = process.env.ARCH_MAP_MODEL || process.env.REVIEW_GROUP_MODEL || process.env.AC_JUDGE_MODEL || "";
const map = parseGeneratedMap(await runHeadless(model)(mapPrompt(paths)), git("rev-parse", "HEAD"));
if (!map) {
  console.error("[arch-map] the model returned no usable map");
  process.exit(1);
}
const dest = archMapPath(codebase);
writeFileSync(dest, JSON.stringify(map, null, 2) + "\n");
console.log(`[arch-map] wrote ${map.nodes.length} nodes and ${map.edges.length} edges to ${dest}`);
