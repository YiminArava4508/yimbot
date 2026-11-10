// neo-blessed ships no types; treat as any at the import boundary.
import blessed from "neo-blessed";
import { existsSync, readFileSync } from "node:fs";
import { spawnPty } from "./claude-sessions.ts";
import { fetchTeamLabels, fetchTeamStates, fetchTeams, fetchViewer } from "./linear-api.ts";
import { configFromEnv, envPath, writeEnvFile, type YimbotConfig } from "./settings-model.ts";
import { checkAll, detectPackageManager, ensureHostLinks } from "./setup-core.ts";
import { finishWizard, validateKey, type FinishResult } from "./setup-wizard.ts";
import { screenTerm } from "./tui.ts";
import type { SettingsDeps } from "./tui-settings.ts";
import { openSetup, type SetupDeps, type SpawnArgv } from "./tui-setup.ts";

// Fix commands (installers, gh auth login) have no use for the Linear key.
export function fixCommandEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && k !== "LINEAR_API_KEY") out[k] = v;
  }
  return out;
}

const fixSpawn: SpawnArgv = (cwd, argv, cols, rows) =>
  spawnPty(argv[0], argv.slice(1), cwd, cols, rows, fixCommandEnv(process.env));

export type LinearApi = {
  fetchViewer: (apiKey: string) => Promise<{ name: string }>;
  fetchTeams: (apiKey: string) => Promise<{ id: string; name: string }[]>;
  fetchTeamStates: (apiKey: string, teamId: string) => Promise<{ name: string }[]>;
  fetchTeamLabels: (apiKey: string, teamId: string) => Promise<string[]>;
};

const defaultLinearApi: LinearApi = { fetchViewer, fetchTeams, fetchTeamStates, fetchTeamLabels };

// The settings panel's Linear lookups. The key is read through a getter: the
// board reads process.env fresh, the wizard passes the key it just validated.
export function linearSettingsDeps(
  key: () => string,
  api: LinearApi = defaultLinearApi,
): Omit<SettingsDeps, "loadConfig" | "apply"> {
  // Matched case-insensitively, same as the daemon's own resolveContext
  // (eqIgnoreCase in linear-api.ts), so a team name that differs only in case
  // from Linear's still resolves instead of silently returning [].
  const findTeam = async (teamName: string) =>
    (await api.fetchTeams(key())).find((t) => t.name.toLowerCase() === teamName.toLowerCase());
  return {
    assignee: async () => (await api.fetchViewer(key())).name,
    teams: async () => (await api.fetchTeams(key())).map((t) => t.name),
    states: async (teamName) => {
      const team = await findTeam(teamName);
      return team ? (await api.fetchTeamStates(key(), team.id)).map((s) => s.name) : [];
    },
    labels: async (teamName) => {
      const team = await findTeam(teamName);
      return team ? await api.fetchTeamLabels(key(), team.id) : [];
    },
  };
}

const setProcessEnv = (record: Record<string, string>): void => {
  for (const [k, v] of Object.entries(record)) process.env[k] = v;
};

export type FirstRunOptions = {
  path?: string;
  installLinks?: () => string[];
  setProcessEnv?: (record: Record<string, string>) => void;
};

// writeEnvFile already moves the old .env to .env.bak, so backupEnv is a no-op.
export function firstRunFinish(config: YimbotConfig, opts: FirstRunOptions = {}): FinishResult {
  const path = opts.path ?? envPath;
  return finishWizard(config, {
    readEnv: () => (existsSync(path) ? readFileSync(path, "utf8") : null),
    writeEnv: (contents) => writeEnvFile(contents, path),
    backupEnv: () => {},
    installLinks: opts.installLinks ?? (() => ensureHostLinks()),
    setProcessEnv: opts.setProcessEnv ?? setProcessEnv,
  });
}

// On a live board the settings apply path writes .env and restarts the
// daemon (which heals host links on start), so the wizard itself writes nothing.
export function reconfigureFinish(): FinishResult {
  return { ok: true, linkResults: [] };
}

export function setupDeps(finish: SetupDeps["finish"]): SetupDeps {
  return {
    initial: configFromEnv(process.env),
    checkAll,
    pm: detectPackageManager(),
    spawn: fixSpawn,
    validateKey,
    settings: (apiKey) => ({
      ...linearSettingsDeps(() => apiKey),
      loadConfig: () => configFromEnv(process.env),
      apply: async () => ({ ok: true }),
    }),
    finish,
  };
}

// First run: the wizard gets its own screen before the daemon or board exist,
// so there is nothing to restart once it hands over.
export function runTuiSetup(): Promise<YimbotConfig | null> {
  const term = screenTerm(process.env.TERM);
  const screen = blessed.screen({ smartCSR: true, title: "yimbot setup", fullUnicode: true, ...(term ? { term } : {}) });
  return new Promise((resolve) => {
    openSetup(screen, setupDeps((c) => firstRunFinish(c)), (result) => {
      screen.destroy();
      resolve(result?.config ?? null);
    });
  });
}
