// src/self-update-wiring.ts
// Glue between index.ts and the self-updater: resolves the repo's git dir and
// boot sha, guards each check with the update lock, and logs every state change.
import { execFileSync } from "node:child_process";
import {
  checkForUpdate,
  gitProbe,
  pnpmPrep,
  pollIntervalMs,
  selfUpdateEnabled,
  startSelfUpdater,
  withUpdateLock,
  type GitProbe,
  type PrepDeps,
  type SelfUpdaterDeps,
  type UpdateState,
} from "./self-update.ts";

export const SAFE_CHECK_MS = 10_000;

export type SelfUpdateHandle = { state: () => UpdateState | null; bootSha: string; stop: () => void };

type WiringDeps = {
  git: GitProbe;
  prep: PrepDeps;
  gitDir: () => string;
  headSha: () => string;
  setTimer: SelfUpdaterDeps["setTimer"];
};

const gitOut = (dir: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

const realTimer: SelfUpdaterDeps["setTimer"] = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return { clear: () => clearTimeout(t) };
};

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function describe(s: UpdateState): string {
  if (s.kind === "ready") return `ready ${s.target.slice(0, 7)}`;
  if (s.kind === "blocked") return `blocked: ${s.reason}`;
  return "current";
}

export function startSelfUpdate(opts: {
  repoDir: string;
  env: NodeJS.ProcessEnv;
  isSafe: () => boolean;
  restart: () => void;
  log: (msg: string) => void;
  deps?: Partial<WiringDeps>;
}): SelfUpdateHandle | null {
  if (!selfUpdateEnabled(opts.env)) return null;
  const { repoDir, log } = opts;
  const git = opts.deps?.git ?? gitProbe(repoDir);
  const prep = opts.deps?.prep ?? pnpmPrep(repoDir);
  // A worktree's .git is a file, so ask git for the real directory.
  const gitDir = opts.deps?.gitDir ?? (() => gitOut(repoDir, "rev-parse", "--absolute-git-dir"));
  const headSha = opts.deps?.headSha ?? (() => gitOut(repoDir, "rev-parse", "HEAD"));
  let bootSha: string;
  try {
    bootSha = headSha();
  } catch (err) {
    log(`[self-update] disabled, cannot read HEAD: ${errText(err)}`);
    return null;
  }
  const skipped = new Set(opts.env.YIMBOT_SKIP_SHA ? [opts.env.YIMBOT_SKIP_SHA] : []);
  let state: UpdateState | null = null;

  const check = async (): Promise<UpdateState> => {
    let result: UpdateState | null;
    try {
      result = await withUpdateLock(gitDir(), () => checkForUpdate(bootSha, git, prep, skipped));
    } catch (err) {
      log(`[self-update] check failed: ${errText(err)}`);
      throw err;
    }
    if (result === null) {
      log("[self-update] another process holds the update lock, keeping the previous state");
      throw new Error("update lock held");
    }
    return result;
  };

  const stillValid = async (target: string): Promise<boolean> => {
    try {
      return (await git.branch()) === "master" && (await git.isClean()) && (await git.head()) === target;
    } catch (err) {
      log(`[self-update] validity check failed: ${errText(err)}`);
      throw err;
    }
  };

  const stop = startSelfUpdater(
    {
      check,
      isSafe: opts.isSafe,
      stillValid,
      restart: () => {
        log("[self-update] restarting onto the new code");
        opts.restart();
      },
      onState: (s) => {
        state = s;
        log(`[self-update] state ${describe(s)}`);
      },
      setTimer: opts.deps?.setTimer ?? realTimer,
    },
    { pollMs: pollIntervalMs(opts.env), safeCheckMs: SAFE_CHECK_MS },
  );

  return { state: () => state, bootSha, stop };
}
