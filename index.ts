// index.ts
import { createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";
import { envOr } from "./src/env.ts";
import { emitEvent } from "./src/events.ts";
import { readMode, toggleMode } from "./src/mode.ts";
import { isConfigured, runSetup, configToEnvRecord } from "./src/setup.ts";
import { startDaemon } from "./src/daemon.ts";
import { returnKey, runTui } from "./src/tui.ts";
import {
  bindReturnKey,
  currentTmuxPane,
  listGitWorktrees,
  listTmuxSessions,
  liveWorktreeKeys,
  resolveSessionForKey,
  switchToSession,
  unbindReturnKey,
} from "./src/watcher.ts";

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
    const original = { log: console.log, warn: console.warn, error: console.error };
    stream.on("error", () => {
      // Stream failed to open or write (bad path, permissions): restore console so the
      // daemon keeps logging and the unhandled 'error' event cannot crash the process.
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    });
    const write = (...args: unknown[]) => void stream.write(format(...args) + "\n");
    console.log = write;
    console.warn = write;
    console.error = write;
  } catch {
    // Keep console.* on stdout if the redirect cannot be set up; the TUI may show
    // stray lines but the daemon still runs.
  }
}

if (process.stdout.isTTY) {
  redirectConsoleToFile();
  const codebasePath = envOr("CODEBASE_PATH", join(homedir(), "Work/gemini"));
  const stop = await startDaemon();
  const returnKeyName = returnKey();
  const boardPane = currentTmuxPane();
  if (boardPane && !bindReturnKey(boardPane, returnKeyName)) {
    console.error(`[tui] could not bind prefix+${returnKeyName} to return to the board pane '${boardPane}'`);
  }
  runTui({
    onQuit: () => {
      if (boardPane) unbindReturnKey(returnKeyName);
      stop();
      process.exit(0);
    },
    liveKeys: () => liveWorktreeKeys(codebasePath),
    onToggleFlag: (key, label, flagged) =>
      emitEvent(
        flagged
          ? { kind: "unflagged", key, label }
          : { kind: "flagged", key, label, reason: "manual" },
      ),
    onOpenSession: (key) => {
      const session = resolveSessionForKey(key, listGitWorktrees(codebasePath), listTmuxSessions());
      if (session) switchToSession(session);
    },
    mode: readMode,
    onToggleMode: toggleMode,
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
