import { existsSync } from "node:fs";
import { envOr } from "./src/env.ts";
import { resolveContext } from "./src/linear-api.ts";
import { sessionScriptPath, startWatcher } from "./src/watcher.ts";

const apiKey = process.env.LINEAR_API_KEY?.trim() ?? "";
const teamName = envOr("LINEAR_TEAM_NAME", "Engineering");
const stateName = envOr("TRIGGER_STATE_NAME", "In Progress");
const pollIntervalMinutes = Number(envOr("POLL_INTERVAL_MINUTES", "3"));

if (!apiKey) throw new Error("LINEAR_API_KEY is required");
if (!Number.isFinite(pollIntervalMinutes) || pollIntervalMinutes <= 0) {
  throw new Error("POLL_INTERVAL_MINUTES must be a positive number");
}
if (!existsSync(sessionScriptPath)) {
  throw new Error(`new-session.sh not found at ${sessionScriptPath}`);
}

const context = await resolveContext(apiKey, teamName, stateName);
console.log(
  `[linear-helper] watching "${teamName}" for issues entering "${stateName}" every ${pollIntervalMinutes}m`,
);

const stop = startWatcher({ apiKey, context, pollIntervalMinutes });

process.on("SIGINT", () => {
  console.log("\n[linear-helper] shutting down");
  stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("[linear-helper] shutting down");
  stop();
  process.exit(0);
});
