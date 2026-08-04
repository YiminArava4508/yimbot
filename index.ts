import { configToEnvRecord, isConfigured, runSetup } from "./src/setup.ts";
import { startDaemon } from "./src/daemon.ts";

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

const stop = await startDaemon();

function shutdown(): void {
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
