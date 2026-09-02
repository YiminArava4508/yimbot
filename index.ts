// index.ts
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";
import { execFile } from "node:child_process";
import { envOr } from "./src/env.ts";
import { deriveKey, emitEvent, emitQueuedToMerge } from "./src/events.ts";
import { applyReadyLabel, ghRunner, prDiff, prReviewMeta } from "./src/gh.ts";
import { readMode, toggleMode } from "./src/mode.ts";
import { readRefineEnabled, refineEnvDefault, writeRefineEnabled } from "./src/refine-toggle.ts";
import { isConfigured, runSetup, configToEnvRecord } from "./src/setup.ts";
import { startDaemon } from "./src/daemon.ts";
import { returnKey, runTui } from "./src/tui.ts";
import { fetchTeamLabels, fetchTeamStates, fetchTeams, fetchViewer } from "./src/linear-api.ts";
import { applySettings } from "./src/settings-apply.ts";
import { configFromEnv, envPath, writeEnvFile } from "./src/settings-model.ts";
import type { SettingsDeps } from "./src/tui-settings.ts";
import { readFlow, readGroups, readViewed, writeFlow, writeGroups, writeViewed } from "./src/review-state.ts";
import type { ReviewDeps } from "./src/tui-review.ts";
import { archMapPath } from "./src/arch-map.ts";
import { runHeadless } from "./src/headless.ts";
import { ensureContextScaffold, makeSessionRegistry, spawnClaudePty } from "./src/claude-sessions.ts";
import { contextFilePath } from "./src/review-context.ts";
import {
  bindReturnKey,
  currentTmuxPane,
  listGitWorktrees,
  listTmuxSessions,
  liveRefineKeys,
  liveWorktreeKeys,
  manuallyLiveKeys,
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
    apply: async (next, prev) => {
      const result = await applySettings(next, prev, {
        readEnv: () => (existsSync(envPath) ? readFileSync(envPath, "utf8") : null),
        writeEnv: (contents) => writeEnvFile(contents),
        setProcessEnv: (record) => {
          for (const [k, v] of Object.entries(record)) process.env[k] = v;
        },
        restart: async () => {
          stop();
          stop = await startDaemon();
        },
      });
      // The panel's auto-refine choice must win over a toggle file left by an
      // older session, or it would silently override what the user just applied.
      if (result.ok) writeRefineEnabled(next.autoRefine);
      return result;
    },
  };
  // Same headless claude -p shape as the daemon's judgeRun; the given model env
  // overrides, falling back to the judge's model knob.
  const headless = (model: string) => runHeadless(model, currentCodebasePath());
  const claudeRegistry = makeSessionRegistry(spawnClaudePty);
  // The claude session runs in the PR's worktree so it can read the actual
  // branch; a PR-only row with no worktree falls back to the main checkout.
  const worktreeForKey = (key: string): string => {
    const wt = listGitWorktrees(currentCodebasePath()).find(
      (w) => deriveKey({ branch: w.branch }).key === key,
    );
    return wt?.path ?? currentCodebasePath();
  };
  // Queue a PR the operator signed off on by hand: promote it if it is still a
  // draft, label it, then move its row now rather than leaving it where it was
  // until the next heartbeat re-reports the section. Shared by the board's r
  // and the review overlay's y.
  const queueToMerge = async (pr: number, key: string, label: string): Promise<void> => {
    const readyLabel = envOr("READY_MERGE_LABEL", "ready-to-merge");
    await applyReadyLabel(ghRunner(currentCodebasePath()), pr, readyLabel);
    emitQueuedToMerge({ key, label, pr });
  };
  const reviewDeps = (pr: number, key: string, label: string): ReviewDeps => {
    const run = ghRunner(currentCodebasePath());
    const cwd = worktreeForKey(key);
    return {
      pr,
      fetchDiff: () => prDiff(run, pr),
      fetchMeta: () => prReviewMeta(run, pr),
      runGrouping: (prompt) => headless(envOr("REVIEW_GROUP_MODEL", envOr("AC_JUDGE_MODEL", "")))(prompt),
      markReady: () => queueToMerge(pr, key, label),
      loadViewed: (headSha) => readViewed(pr, headSha),
      saveViewed: (headSha, viewed) => writeViewed(pr, headSha, viewed),
      loadGroups: (headSha) => readGroups(pr, headSha),
      saveGroups: (headSha, groups) => writeGroups(pr, headSha, groups),
      loadArchMap: () => {
        try {
          return readFileSync(archMapPath(currentCodebasePath()), "utf8");
        } catch {
          return null;
        }
      },
      runAnnotation: (prompt) =>
        headless(envOr("ARCH_ANNOTATE_MODEL", envOr("REVIEW_GROUP_MODEL", envOr("AC_JUDGE_MODEL", ""))))(prompt),
      loadFlow: (headSha) => readFlow(pr, headSha),
      saveFlow: (headSha, flow) => writeFlow(pr, headSha, flow),
      regenerateArchMap: () =>
        new Promise<void>((resolve, reject) => {
          execFile(
            process.execPath,
            ["--import", "tsx/esm", join(import.meta.dirname, "scripts/arch-map.ts")],
            { env: { ...process.env, CODEBASE_PATH: currentCodebasePath() } },
            (err) => (err ? reject(err) : resolve()),
          );
        }),
      claudeSession: () => {
        try {
          return claudeRegistry.getOrSpawn(pr, cwd);
        } catch (err) {
          console.error(`[review] claude session for #${pr} failed:`, err);
          return null;
        }
      },
      writeContext: (content) => {
        try {
          ensureContextScaffold(cwd);
          writeFileSync(contextFilePath(cwd), content);
          return true;
        } catch (err) {
          console.error(`[review] context write for #${pr} failed:`, err);
          return false;
        }
      },
    };
  };
  runTui({
    onQuit: () => {
      if (boardPane) unbindReturnKey(returnKeyName);
      claudeRegistry.killAll();
      stop();
      process.exit(0);
    },
    liveKeys: () => {
      const keys = liveWorktreeKeys(currentCodebasePath());
      for (const k of liveRefineKeys(listTmuxSessions())) keys.add(k);
      return keys;
    },
    manualLiveKeys: () => manuallyLiveKeys(listGitWorktrees(currentCodebasePath()), listTmuxSessions()),
    onToggleFlag: (key, label, flagged) =>
      emitEvent(
        flagged
          ? { kind: "unflagged", key, label }
          : { kind: "flagged", key, label, reason: "manual" },
      ),
    onAddReadyLabel: queueToMerge,
    onOpenSession: (key) => {
      const session = resolveSessionForKey(key, listGitWorktrees(currentCodebasePath()), listTmuxSessions());
      if (session) switchToSession(session);
    },
    mode: readMode,
    onToggleMode: toggleMode,
    refineEnabled: () => readRefineEnabled(refineEnvDefault(process.env)),
    settings,
    reviewDeps,
    orderDeps: {
      fetchMeta: (pr) => prReviewMeta(ghRunner(currentCodebasePath()), pr),
      run: (prompt) =>
        headless(envOr("REVIEW_ORDER_MODEL", envOr("REVIEW_GROUP_MODEL", envOr("AC_JUDGE_MODEL", ""))))(prompt),
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
