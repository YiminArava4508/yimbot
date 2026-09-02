// scripts/arch-map.ts
// Regenerates the reviewed codebase's architecture map. One headless call,
// spawned as its own process by the overlay's G key or run by hand.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { archMapPath } from "../src/arch-map.ts";
import { mapPrompt, parseGeneratedMap, sourcePaths } from "../src/arch-generate.ts";
import { envOr } from "../src/env.ts";
import { runHeadless } from "../src/headless.ts";

const codebase = envOr("CODEBASE_PATH", join(homedir(), "Work/gemini"));
const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: codebase, encoding: "utf8" }).trim();

const paths = sourcePaths(git("ls-files").split("\n"));
if (paths.length === 0) {
  console.error(`[arch-map] no source files under ${codebase}`);
  process.exit(1);
}
const model = envOr("ARCH_MAP_MODEL", envOr("REVIEW_GROUP_MODEL", envOr("AC_JUDGE_MODEL", "")));
// Mapping a whole repo is the longest call yimbot makes, well past the default
// a review step wants to fail fast on.
const run = runHeadless(model, codebase, 600_000);
const map = parseGeneratedMap(await run(mapPrompt(paths)), git("rev-parse", "HEAD"));
if (!map) {
  console.error("[arch-map] the model returned no usable map");
  process.exit(1);
}
const dest = archMapPath(codebase);
// A reviewed repo need not already have a docs/ directory, and the ENOENT would
// surface through execFile as a raw error in the overlay's footer.
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify(map, null, 2) + "\n");
console.log(`[arch-map] wrote ${map.nodes.length} nodes and ${map.edges.length} edges to ${dest}`);
