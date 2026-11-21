// src/self-update.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

export type UpdateState =
  | { kind: "current" }
  | { kind: "ready"; target: string }
  | { kind: "blocked"; reason: string };

export type GitProbe = {
  fetch(): Promise<void>;
  branch(): Promise<string>;
  head(): Promise<string>;
  originHead(): Promise<string>;
  isClean(): Promise<boolean>;
  isAncestor(a: string, b: string): Promise<boolean>;
  pullFfOnly(): Promise<void>;
  changedFiles(from: string, to: string): Promise<string[]>;
};

export type PrepDeps = {
  install(): Promise<void>;
  typecheck(): Promise<boolean>;
};

const blocked = (reason: string): UpdateState => ({ kind: "blocked", reason });

// Maps a sha that must never be applied to the reason the status bar shows.
export type SkippedShas = Map<string, string>;

async function newestSha(git: GitProbe, head: string, origin: string): Promise<string | null> {
  if (head === origin || (await git.isAncestor(origin, head))) return head;
  if (await git.isAncestor(head, origin)) return origin;
  return null;
}

export async function checkForUpdate(
  bootSha: string,
  git: GitProbe,
  prep: PrepDeps,
  skipped: SkippedShas,
  readyTarget?: string,
): Promise<UpdateState> {
  try {
    await git.fetch();
  } catch {
    return blocked("fetch failed");
  }
  if ((await git.branch()) !== "master") return blocked("not on master");
  if (!(await git.isClean())) return blocked("dirty tree");

  const head = await git.head();
  const target = await newestSha(git, head, await git.originHead());
  if (target === null) return blocked("diverged");
  if (target === bootSha) return { kind: "current" };
  const skipReason = skipped.get(target);
  if (skipReason) return blocked(skipReason);

  if (head !== target) await git.pullFfOnly();
  if (target === readyTarget) return { kind: "ready", target };

  const changed = await git.changedFiles(bootSha, target);
  if (changed.includes("pnpm-lock.yaml")) await prep.install();

  if (!(await prep.typecheck())) {
    const reason = `typecheck fails at ${target.slice(0, 7)}`;
    skipped.set(target, reason);
    return blocked(reason);
  }
  return { kind: "ready", target };
}

export function gitProbe(dir: string): GitProbe {
  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync("git", args, { cwd: dir });
    return stdout.trim();
  };
  return {
    async fetch() {
      await git("fetch", "origin", "master");
    },
    branch: () => git("rev-parse", "--abbrev-ref", "HEAD"),
    head: () => git("rev-parse", "HEAD"),
    originHead: () => git("rev-parse", "origin/master"),
    async isClean() {
      return (await git("status", "--porcelain")) === "";
    },
    async isAncestor(a, b) {
      try {
        await git("merge-base", "--is-ancestor", a, b);
        return true;
      } catch {
        return false;
      }
    },
    async pullFfOnly() {
      await git("merge", "--ff-only", "origin/master");
    },
    async changedFiles(from, to) {
      const out = await git("diff", "--name-only", `${from}..${to}`);
      return out === "" ? [] : out.split("\n");
    },
  };
}

export function pnpmPrep(dir: string): PrepDeps {
  return {
    async install() {
      await execFileAsync("pnpm", ["install", "--frozen-lockfile"], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
    },
    async typecheck() {
      try {
        await execFileAsync("pnpm", ["typecheck"], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
        return true;
      } catch {
        return false;
      }
    },
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tryCreate(path: string): boolean {
  try {
    writeFileSync(path, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

export async function withUpdateLock<T>(dir: string, fn: () => Promise<T>): Promise<T | null> {
  const path = join(dir, "yimbot-update.lock");
  if (!tryCreate(path)) {
    let holder = NaN;
    try {
      holder = Number.parseInt(readFileSync(path, "utf8"), 10);
    } catch {
      // Lock vanished between the create and the read; retry below.
    }
    if (Number.isFinite(holder) && pidAlive(holder)) return null;
    try {
      unlinkSync(path);
    } catch {
      // Another process reclaimed it first.
    }
    if (!tryCreate(path)) return null;
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // Already gone.
    }
  }
}

export type SelfUpdaterDeps = {
  check(prev: UpdateState | undefined): Promise<UpdateState>;
  isSafe(): boolean;
  stillValid(target: string): Promise<boolean>;
  restart(): void;
  onState(s: UpdateState): void;
  setTimer(fn: () => void, ms: number): { clear(): void };
};

export function selfUpdateEnabled(env: NodeJS.ProcessEnv): boolean {
  return !["false", "off", "no", "0"].includes((env.SELF_UPDATE ?? "true").toLowerCase());
}

export function pollIntervalMs(env: NodeJS.ProcessEnv): number {
  const minutes = Number(env.SELF_UPDATE_INTERVAL_MINUTES ?? "5");
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 5) * 60_000;
}

export function startSelfUpdater(
  deps: SelfUpdaterDeps,
  opts: { pollMs: number; safeCheckMs: number; autoRestart?: boolean },
): () => void {
  let state: UpdateState | undefined;
  let stopped = false;
  let checking = false;
  let ticking = false;
  let pollTimer: { clear(): void } | undefined;
  let safeTimer: { clear(): void } | undefined;
  const autoRestart = opts.autoRestart ?? true;

  const setState = (next: UpdateState) => {
    if (state && JSON.stringify(state) === JSON.stringify(next)) return;
    state = next;
    deps.onState(next);
  };

  const armSafe = () => {
    if (stopped || safeTimer) return;
    safeTimer = deps.setTimer(() => {
      safeTimer = undefined;
      void safeTick();
    }, opts.safeCheckMs);
  };

  const safeTick = async () => {
    if (ticking || stopped) return;
    ticking = true;
    try {
      if (state?.kind !== "ready") return;
      const target = state.target;
      if (checking || !deps.isSafe()) return armSafe();
      const valid = await deps.stillValid(target);
      if (stopped) return;
      if (state?.kind !== "ready" || state.target !== target) return;
      if (!valid) {
        setState({ kind: "blocked", reason: "dirty tree" });
        return;
      }
      if (checking || !deps.isSafe()) return armSafe();
      deps.restart();
    } catch {
      armSafe();
    } finally {
      ticking = false;
    }
  };

  const runCheck = async () => {
    if (checking || stopped) return;
    checking = true;
    try {
      setState(await deps.check(state));
    } catch {
      // Keep the previous state and try again on the next poll.
    } finally {
      checking = false;
    }
    if (autoRestart && state?.kind === "ready") armSafe();
  };

  const schedulePoll = () => {
    if (stopped) return;
    pollTimer = deps.setTimer(() => {
      void runCheck().finally(schedulePoll);
    }, opts.pollMs);
  };

  void runCheck();
  schedulePoll();

  return () => {
    stopped = true;
    pollTimer?.clear();
    safeTimer?.clear();
  };
}
