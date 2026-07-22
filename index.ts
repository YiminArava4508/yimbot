import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pullCodebase } from "./src/codebase-sync.ts";
import { envOr } from "./src/env.ts";
import { resolveContext } from "./src/linear-api.ts";
import { configToEnvRecord, isConfigured, runSetup } from "./src/setup.ts";
import { runLocalEnvScriptPath, sessionScriptPath, startWatcher } from "./src/watcher.ts";

// First-run onboarding: with no API key configured (fresh clone, or .env never
// filled in), walk the user through setup, write .env, and apply the result to
// this process's env so the daemon starts immediately after. Node loads .env via
// --env-file-if-exists, so a missing file no longer crashes before we get here.
if (!isConfigured(process.env)) {
  const config = await runSetup();
  for (const [key, value] of Object.entries(configToEnvRecord(config))) {
    process.env[key] = value;
  }
}

const apiKey = process.env.LINEAR_API_KEY?.trim() ?? "";
const teamName = envOr("LINEAR_TEAM_NAME", "Engineering");
const stateName = envOr("TRIGGER_STATE_NAME", "In Progress");
const reviewStateName = envOr("REVIEW_STATE_NAME", "In Review");
// The heartbeat: how often the central loop ticks. Reads the new
// HEARTBEAT_INTERVAL_MINUTES, falling back to the legacy POLL_INTERVAL_MINUTES.
const heartbeatIntervalMinutes = Number(
  envOr("HEARTBEAT_INTERVAL_MINUTES", envOr("POLL_INTERVAL_MINUTES", "3")),
);
const codebasePath = envOr("CODEBASE_PATH", join(homedir(), "Work/gemini"));
// Resuming the local dev env when a ticket enters "In Review" is opt-in and off
// by default — only "true"/"on"/"yes"/"1" enables it.
const resumeOnReview = ["true", "on", "yes", "1"].includes(
  envOr("RESUME_ON_REVIEW", "false").toLowerCase(),
);

// Autonomous picker config. AUTO_PICK is on unless explicitly disabled with a
// recognized off-value (false/off/no/0), so an intuitive toggle can't silently
// leave picking enabled.
const autoPick = !["false", "off", "no", "0"].includes(envOr("AUTO_PICK", "true").toLowerCase());
const maxReview = Number(envOr("MAX_REVIEW", "3"));
const riskLabels = envOr("RISK_LABELS", "migration,infra,security,breaking")
  .split(",")
  .map((l) => l.trim())
  .filter(Boolean);
const todoStateName = envOr("TODO_STATE_NAME", "Todo");

if (!apiKey) throw new Error("LINEAR_API_KEY is required");
if (!Number.isFinite(heartbeatIntervalMinutes) || heartbeatIntervalMinutes <= 0) {
  throw new Error("HEARTBEAT_INTERVAL_MINUTES must be a positive number");
}
if (!Number.isFinite(maxReview) || maxReview <= 0) {
  throw new Error("MAX_REVIEW must be a positive number");
}
if (!existsSync(sessionScriptPath)) {
  throw new Error(`new-session.sh not found at ${sessionScriptPath}`);
}
if (resumeOnReview && !existsSync(runLocalEnvScriptPath)) {
  throw new Error(`run-local-env.sh not found at ${runLocalEnvScriptPath}`);
}
if (!existsSync(codebasePath)) {
  throw new Error(`CODEBASE_PATH does not exist: ${codebasePath}`);
}
try {
  execFileSync("git", ["-C", codebasePath, "rev-parse", "--git-dir"], { stdio: "ignore" });
} catch {
  throw new Error(`CODEBASE_PATH is not a git repository: ${codebasePath}`);
}

const progressContext = await resolveContext(apiKey, teamName, stateName);
const reviewContext = await resolveContext(apiKey, teamName, reviewStateName);
const todoContext = await resolveContext(apiKey, teamName, todoStateName);
console.log(
  `[yimbot] watching "${teamName}": launch on "${stateName}", ${resumeOnReview ? `resume dev env on "${reviewStateName}", ` : ""}every ${heartbeatIntervalMinutes}m; syncing ${codebasePath}`,
);
console.log(
  autoPick
    ? `[yimbot] auto-pick ON: from "${todoStateName}" in the active cycle, 1 in progress, max ${maxReview} in review; skipping labels [${riskLabels.join(", ")}]`
    : "[yimbot] auto-pick OFF",
);

const stop = startWatcher({
  apiKey,
  progressContext,
  reviewContext,
  heartbeatIntervalMinutes,
  resumeOnReview,
  picker: {
    autoPick,
    maxReview,
    riskLabels,
    todoContext,
    progressStateName: stateName,
    reviewStateName,
  },
});

void pullCodebase(codebasePath);
const syncTimer = setInterval(
  () => void pullCodebase(codebasePath),
  heartbeatIntervalMinutes * 60 * 1000,
);

function shutdown(): void {
  clearInterval(syncTimer);
  stop();
  process.exit(0);
}

process.on("SIGINT", () => {
  console.log("\n[yimbot] shutting down");
  shutdown();
});
process.on("SIGTERM", () => {
  console.log("[yimbot] shutting down");
  shutdown();
});
