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

export async function checkForUpdate(
  bootSha: string,
  git: GitProbe,
  prep: PrepDeps,
  skipped: Set<string>,
): Promise<UpdateState> {
  try {
    await git.fetch();
  } catch {
    return blocked("fetch failed");
  }
  if ((await git.branch()) !== "master") return blocked("not on master");
  if (!(await git.isClean())) return blocked("dirty tree");

  const head = await git.head();
  const origin = await git.originHead();
  if (head === bootSha && origin === bootSha) return { kind: "current" };

  if (head !== origin && !(await git.isAncestor(origin, head))) {
    if (!(await git.isAncestor(head, origin))) return blocked("diverged");
    await git.pullFfOnly();
  }

  const target = await git.head();
  if (skipped.has(target)) return blocked(`typecheck fails at ${target.slice(0, 7)}`);

  const changed = await git.changedFiles(bootSha, target);
  if (changed.includes("pnpm-lock.yaml")) await prep.install();

  if (!(await prep.typecheck())) {
    skipped.add(target);
    return blocked(`typecheck fails at ${target.slice(0, 7)}`);
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
      await execFileAsync("pnpm", ["install", "--frozen-lockfile"], { cwd: dir });
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
  const path = join(dir, "self-update.lock");
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
