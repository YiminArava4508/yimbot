import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveContext } from "./src/linear-api.ts";
import { startWatcher } from "./src/watcher.ts";

const apiKey = process.env.LINEAR_API_KEY ?? "";
const teamName = process.env.LINEAR_TEAM_NAME ?? "Engineering";
const stateName = process.env.TRIGGER_STATE_NAME ?? "In Progress";
const pollIntervalMinutes = Number(process.env.POLL_INTERVAL_MINUTES ?? "3");

if (!apiKey) throw new Error("LINEAR_API_KEY is required");
if (!Number.isFinite(pollIntervalMinutes) || pollIntervalMinutes <= 0) {
  throw new Error("POLL_INTERVAL_MINUTES must be a positive number");
}
const sessionScript = join(homedir(), "new-session.sh");
if (!existsSync(sessionScript)) {
  throw new Error(`new-session.sh not found at ${sessionScript}`);
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
  stop();
  process.exit(0);
});
