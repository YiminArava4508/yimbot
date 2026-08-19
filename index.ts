// index.ts
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";
import { envOr } from "./src/env.ts";
import { emitEvent, emitStatus } from "./src/events.ts";
import { addLabel, ghRunner } from "./src/gh.ts";
import { readMode, toggleMode } from "./src/mode.ts";
import { isConfigured, runSetup, configToEnvRecord } from "./src/setup.ts";
import { startDaemon } from "./src/daemon.ts";
import { returnKey, runTui } from "./src/tui.ts";
import { fetchTeamLabels, fetchTeamStates, fetchTeams, fetchViewer } from "./src/linear-api.ts";
import { applySettings } from "./src/settings-apply.ts";
import { configFromEnv, envPath, writeEnvFile } from "./src/settings-model.ts";
import type { SettingsDeps } from "./src/tui-settings.ts";
import {
  bindReturnKey,
  currentTmuxPane,
  listGitWorktrees,
  listTmuxSessions,
  liveRefineKeys,
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

// Read fresh rather than captured once: the settings panel can restart the
// daemon on a new CODEBASE_PATH mid-session, and callers that closed over a
// stale value would keep filtering/opening sessions against the old repo.
const currentCodebasePath = () => envOr("CODEBASE_PATH", join(homedir(), "Work/gemini"));

if (process.stdout.isTTY) {
  redirectConsoleToFile();
  let stop = await startDaemon();
  const returnKeyName = returnKey();
  const boardPane = currentTmuxPane();
  if (boardPane && !bindReturnKey(boardPane, returnKeyName)) {
    console.error(`[tui] could not bind prefix+${returnKeyName} to return to the board pane '${boardPane}'`);
  }
  const apiKey = () => process.env.LINEAR_API_KEY?.trim() ?? "";
  const settings: SettingsDeps = {
    loadConfig: () => configFromEnv(process.env),
    assignee: async () => (await fetchViewer(apiKey())).name,
    teams: async () => (await fetchTeams(apiKey())).map((t) => t.name),
    states: async (teamName) => {
      // Matched case-insensitively, same as the daemon's own resolveContext
      // (eqIgnoreCase in linear-api.ts), so a team name that differs only in
      // case from Linear's still resolves instead of silently returning [].
      const team = (await fetchTeams(apiKey())).find((t) => t.name.toLowerCase() === teamName.toLowerCase());
      return team ? (await fetchTeamStates(apiKey(), team.id)).map((s) => s.name) : [];
    },
    labels: async (teamName) => {
      const team = (await fetchTeams(apiKey())).find((t) => t.name.toLowerCase() === teamName.toLowerCase());
      return team ? await fetchTeamLabels(apiKey(), team.id) : [];
    },
    apply: (next, prev) =>
      applySettings(next, prev, {
        readEnv: () => (existsSync(envPath) ? readFileSync(envPath, "utf8") : null),
        writeEnv: (contents) => writeEnvFile(contents),
        setProcessEnv: (record) => {
          for (const [k, v] of Object.entries(record)) process.env[k] = v;
        },
        restart: async () => {
          stop();
          stop = await startDaemon();
        },
      }),
  };
  runTui({
    onQuit: () => {
      if (boardPane) unbindReturnKey(returnKeyName);
      stop();
      process.exit(0);
    },
    liveKeys: () => {
      const keys = liveWorktreeKeys(currentCodebasePath());
      for (const k of liveRefineKeys(listTmuxSessions())) keys.add(k);
      return keys;
    },
    onToggleFlag: (key, label, flagged) =>
      emitEvent(
        flagged
          ? { kind: "unflagged", key, label }
          : { kind: "flagged", key, label, reason: "manual" },
      ),
    onAddReadyLabel: (pr, key, label) => {
      const readyLabel = envOr("READY_MERGE_LABEL", "ready-to-merge");
      addLabel(ghRunner(currentCodebasePath()), pr, readyLabel)
        .then(() => emitStatus({ kind: "ready_to_merge", key, label, pr }))
        .catch((err) => console.error(`[tui] manual ${readyLabel} on PR #${pr} failed: ${err}`));
    },
    onOpenSession: (key) => {
      const session = resolveSessionForKey(key, listGitWorktrees(currentCodebasePath()), listTmuxSessions());
      if (session) switchToSession(session);
    },
    mode: readMode,
    onToggleMode: toggleMode,
    settings,
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
