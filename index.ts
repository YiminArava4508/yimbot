import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pullCodebase } from "./src/codebase-sync.ts";
import { envOr } from "./src/env.ts";
import { ghRunner, listMyMergedPRs, listMyOpenPRs, repoSlug, unresolvedThreadCount } from "./src/gh.ts";
import { resolveContext } from "./src/linear-api.ts";
import { configToEnvRecord, isConfigured, runSetup } from "./src/setup.ts";
import { sessionScriptPath, startWatcher } from "./src/watcher.ts";

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
// The deploy step watches this state. Reads the new DEPLOY_STATE_NAME, falling
// back to the legacy TRIGGER_STATE_NAME.
const stateName = envOr("DEPLOY_STATE_NAME", envOr("TRIGGER_STATE_NAME", "In Progress"));
const reviewStateName = envOr("REVIEW_STATE_NAME", "In Review");
// The heartbeat: how often the central loop ticks. Reads the new
// HEARTBEAT_INTERVAL_MINUTES, falling back to the legacy POLL_INTERVAL_MINUTES.
const heartbeatIntervalMinutes = Number(
  envOr("HEARTBEAT_INTERVAL_MINUTES", envOr("POLL_INTERVAL_MINUTES", "3")),
);
const codebasePath = envOr("CODEBASE_PATH", join(homedir(), "Work/gemini"));

// Claim step config. AUTO_CLAIM is on unless explicitly disabled with a
// recognized off-value (false/off/no/0), so an intuitive toggle can't silently
// leave claiming enabled. Falls back to the legacy AUTO_PICK.
const autoClaim = !["false", "off", "no", "0"].includes(
  envOr("AUTO_CLAIM", envOr("AUTO_PICK", "true")).toLowerCase(),
);
const riskLabels = envOr("RISK_LABELS", "migration,infra,security,breaking")
  .split(",")
  .map((l) => l.trim())
  .filter(Boolean);
const todoStateName = envOr("TODO_STATE_NAME", "Todo");
// How many of the viewer's tickets may sit In Progress before the claim step
// stops claiming. Defaults to 3; set to 1 for the old one-at-a-time behavior.
const maxInProgress = Number(envOr("MAX_IN_PROGRESS", "3"));

// Cleanup step: on by default, disabled with a recognized off-value. Removes a
// worktree + session once its PR merges.
const autoCleanup = !["false", "off", "no", "0"].includes(envOr("AUTO_CLEANUP", "true").toLowerCase());

if (!apiKey) throw new Error("LINEAR_API_KEY is required");
if (!Number.isInteger(maxInProgress) || maxInProgress < 1) {
  throw new Error("MAX_IN_PROGRESS must be a positive integer");
}
if (!Number.isFinite(heartbeatIntervalMinutes) || heartbeatIntervalMinutes <= 0) {
  throw new Error("HEARTBEAT_INTERVAL_MINUTES must be a positive number");
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

const progressContext = await resolveContext(apiKey, teamName, stateName);
const reviewContext = await resolveContext(apiKey, teamName, reviewStateName);
const todoContext = await resolveContext(apiKey, teamName, todoStateName);

// Review step: address comments on the viewer's open PRs. gh resolves the repo
// from CODEBASE_PATH's origin; if gh is missing or that fails, the review step is
// disabled (null) rather than crashing the daemon.
const gh = ghRunner(codebasePath);
let prReview:
  | { listOpenPRs: () => ReturnType<typeof listMyOpenPRs>; unresolvedCount: (n: number) => Promise<number> }
  | null = null;
try {
  const slug = await repoSlug(gh);
  prReview = {
    listOpenPRs: () => listMyOpenPRs(gh),
    unresolvedCount: (n) => unresolvedThreadCount(gh, slug, n),
  };
  console.log(`[yimbot] review step ON: addressing PR comments in ${slug.owner}/${slug.name}`);
} catch (err) {
  console.log(`[yimbot] review step OFF: gh unavailable or repo unresolved (${err})`);
}

// Cleanup step: tear down merged PRs' worktrees. Shares the review step's gh
// availability signal (prReview !== null): if gh is missing, both are off.
const cleanup =
  autoCleanup && prReview
    ? {
        codebasePath,
        listMergedPRs: () => listMyMergedPRs(gh),
      }
    : null;
console.log(
  cleanup
    ? "[yimbot] cleanup step ON: removing worktrees + sessions of merged PRs"
    : `[yimbot] cleanup step OFF${autoCleanup ? " (gh unavailable)" : ""}`,
);

console.log(
  `[yimbot] watching "${teamName}": deploy on "${stateName}", ready-to-test flag on "${reviewStateName}", every ${heartbeatIntervalMinutes}m; syncing ${codebasePath}`,
);
console.log(
  autoClaim
    ? `[yimbot] auto-claim ON: from "${todoStateName}" in the active cycle, up to ${maxInProgress} in progress; skipping labels [${riskLabels.join(", ")}]`
    : "[yimbot] auto-claim OFF",
);

const stop = startWatcher({
  apiKey,
  progressContext,
  reviewContext,
  heartbeatIntervalMinutes,
  claim: {
    autoClaim,
    riskLabels,
    maxInProgress,
    todoContext,
    progressStateName: stateName,
  },
  prReview,
  cleanup,
});

// Re-entrancy guard: a sync that runs longer than one interval must not overlap
// with the next tick's sync.
let syncing = false;
const safeSync = async (): Promise<void> => {
  if (syncing) return;
  syncing = true;
  try {
    await pullCodebase(codebasePath);
  } finally {
    syncing = false;
  }
};
void safeSync();
const syncTimer = setInterval(() => void safeSync(), heartbeatIntervalMinutes * 60 * 1000);

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
