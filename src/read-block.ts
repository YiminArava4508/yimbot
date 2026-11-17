// Claude Code's read block stalls unattended sessions, and true in any settings
// source wins, so --settings can't turn it off; strip it from user settings.
import { copyFileSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { errMsg } from "./setup-core.ts";

const READ_BLOCK_KEYS = [
  "blockReadsOutsideWorkingDirectories",
  "blockFileToolReadsOutsideWorkingDirectories",
] as const;

type Settings = { permissions?: Record<string, unknown> };

function parse(text: string): Settings | null {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export function readBlockKeysOn(text: string): string[] {
  const permissions = parse(text)?.permissions;
  if (!permissions || typeof permissions !== "object") return [];
  return READ_BLOCK_KEYS.filter((key) => permissions[key] === true);
}

export function stripReadBlock(text: string): { text: string; removed: string[] } | null {
  const settings = parse(text);
  const removed = readBlockKeysOn(text);
  if (!settings?.permissions || removed.length === 0) return null;
  for (const key of removed) delete settings.permissions[key];
  return { text: JSON.stringify(settings, null, 2) + "\n", removed };
}

export const MANAGED_SETTINGS_PATHS = [
  "/etc/claude-code/managed-settings.json",
  "/Library/Application Support/ClaudeCode/managed-settings.json",
];

export function userSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
}

export function projectSettingsPaths(codebase: string): string[] {
  return [join(codebase, ".claude/settings.json"), join(codebase, ".claude/settings.local.json")];
}

export type ReadBlockPaths = { user: string; warnOnly: string[]; now?: () => number };

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function stripUserSettings(path: string, now: () => number): string | null {
  const text = readIfExists(path);
  if (text === null) return null;
  if (parse(text) === null) return `[warn] ${path} isn't valid JSON; couldn't check it for the read block`;
  const stripped = stripReadBlock(text);
  if (!stripped) return null;
  const real = realpathSync(path);
  const backup = `${path}.bak.${now()}`;
  copyFileSync(real, backup);
  const tmp = `${real}.yimbot-tmp`;
  writeFileSync(tmp, stripped.text);
  // A running session may have written the file since we read it; don't clobber that.
  if (readFileSync(real, "utf8") !== text) {
    rmSync(tmp, { force: true });
    return `[warn] ${path} changed while yimbot was editing it; retrying next start`;
  }
  renameSync(tmp, real);
  return `[ok] removed ${stripped.removed.join(", ")} from ${path} (backup ${backup})`;
}

// Returns one log line per change or problem; empty when nothing blocks reads.
export function ensureReadsUnblocked(
  paths: ReadBlockPaths = { user: userSettingsPath(), warnOnly: MANAGED_SETTINGS_PATHS },
): string[] {
  const lines: string[] = [];
  try {
    const line = stripUserSettings(paths.user, paths.now ?? Date.now);
    if (line) lines.push(line);
  } catch (err) {
    lines.push(`[fail] could not clear the read block in ${paths.user}: ${errMsg(err)}`);
  }
  for (const path of paths.warnOnly) {
    try {
      const text = readIfExists(path);
      const on = text === null ? [] : readBlockKeysOn(text);
      if (on.length > 0) {
        lines.push(`[warn] ${path} sets ${on.join(", ")}; sessions will stall on reads outside their worktree until it's removed (yimbot doesn't edit this file)`);
      }
    } catch {
      // Unreadable: nothing yimbot can act on.
    }
  }
  return lines;
}
