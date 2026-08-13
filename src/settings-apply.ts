import { configToEnvRecord, serializeEnvFile, type YimbotConfig } from "./settings-model.ts";

export type ApplyEffects = {
  // Current .env contents, null when the file does not exist yet.
  readEnv: () => string | null;
  writeEnv: (contents: string) => void;
  setProcessEnv: (record: Record<string, string>) => void;
  // Stop the running daemon and start it again on the current environment.
  restart: () => Promise<void>;
};

export type ApplyResult = { ok: true } | { ok: false; error: string; rolledBack: boolean };

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Apply a config edit as all or nothing: either the new config is running, or
// the old one is and nothing changed on disk. The daemon validates at startup
// (api key, codebase path, Linear reachability), so a restart is the only way to
// learn whether an edit is viable, and a failed restart has to be undone.
export async function applySettings(
  next: YimbotConfig,
  prev: YimbotConfig,
  effects: ApplyEffects,
): Promise<ApplyResult> {
  const snapshot = effects.readEnv() ?? serializeEnvFile(prev);
  effects.writeEnv(serializeEnvFile(next));
  effects.setProcessEnv(configToEnvRecord(next));
  try {
    await effects.restart();
    return { ok: true };
  } catch (err) {
    const error = errMsg(err);
    effects.writeEnv(snapshot);
    effects.setProcessEnv(configToEnvRecord(prev));
    try {
      await effects.restart();
      return { ok: false, error, rolledBack: true };
    } catch {
      return { ok: false, error, rolledBack: false };
    }
  }
}
