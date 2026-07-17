import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pullCodebase } from "./src/codebase-sync.ts";
import { envOr } from "./src/env.ts";
import { resolveContext } from "./src/linear-api.ts";
import { sessionScriptPath, startWatcher } from "./src/watcher.ts";

const apiKey = process.env.LINEAR_API_KEY?.trim() ?? "";
const teamName = envOr("LINEAR_TEAM_NAME", "Engineering");
const stateName = envOr("TRIGGER_STATE_NAME", "In Progress");
const pollIntervalMinutes = Number(envOr("POLL_INTERVAL_MINUTES", "3"));
const codebasePath = envOr("CODEBASE_PATH", join(homedir(), "Work/gemini"));

if (!apiKey) throw new Error("LINEAR_API_KEY is required");
if (!Number.isFinite(pollIntervalMinutes) || pollIntervalMinutes <= 0) {
  throw new Error("POLL_INTERVAL_MINUTES must be a positive number");
}
if (!existsSync(sessionScriptPath)) {
  throw new Error(`new-session.sh not found at ${sessionScriptPath}`);
}
if (!existsSync(codebasePath)) {
  throw new Error(`CODEBASE_PATH does not exist: ${codebasePath}`);
}
try {
  execFileSync("git", ["-C", codebasePath, "rev-parse", "--git-dir"], { stdio: "ignore" });
} catch {
  throw new Error(`CODEBASE_PATH is not a git repository: ${codebasePath}`);
}

const context = await resolveContext(apiKey, teamName, stateName);
console.log(
  `[linear-helper] watching "${teamName}" for issues entering "${stateName}" every ${pollIntervalMinutes}m, syncing ${codebasePath}`,
);

const stop = startWatcher({ apiKey, context, pollIntervalMinutes });

void pullCodebase(codebasePath);
const syncTimer = setInterval(
  () => void pullCodebase(codebasePath),
  pollIntervalMinutes * 60 * 1000,
);

function shutdown(): void {
  clearInterval(syncTimer);
  stop();
  process.exit(0);
}

process.on("SIGINT", () => {
  console.log("\n[linear-helper] shutting down");
  shutdown();
});
process.on("SIGTERM", () => {
  console.log("[linear-helper] shutting down");
  shutdown();
});
