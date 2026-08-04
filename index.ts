// index.ts
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import { envOr } from "./src/env.ts";
import { isConfigured, runSetup, configToEnvRecord } from "./src/setup.ts";
import { startDaemon } from "./src/daemon.ts";
import { runTui } from "./src/tui.ts";

if (!isConfigured(process.env)) {
  const config = await runSetup();
  for (const [key, value] of Object.entries(configToEnvRecord(config))) {
    process.env[key] = value;
  }
}

function redirectConsoleToFile(): void {
  try {
    const path = envOr("DAEMON_LOG", join(process.cwd(), "daemon.log"));
    const stream = createWriteStream(path, { flags: "a" });
    const write = (...args: unknown[]) => void stream.write(format(...args) + "\n");
    console.log = write;
    console.warn = write;
    console.error = write;
  } catch {
    // Keep console.* on stdout if the log stream cannot open; the TUI may show
    // stray lines but the daemon still runs.
  }
}

if (process.stdout.isTTY) {
  redirectConsoleToFile();
  const stop = await startDaemon();
  runTui({
    onQuit: () => {
      stop();
      process.exit(0);
    },
  });
} else {
  const stop = await startDaemon();
  const shutdown = () => {
    stop();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    console.log("\n[yimbot] shutting down");
    shutdown();
  });
  process.on("SIGTERM", () => {
    console.log("[yimbot] shutting down");
    shutdown();
  });
}
