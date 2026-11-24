import type { SelfImproveJob } from "./self-improve-jobs.ts";
import { isDue, periodKey } from "./self-improve-state.ts";

export type SelfImproveDeps = {
  enabled: () => boolean;
  jobEnabled: (job: SelfImproveJob) => boolean;
  jobs: SelfImproveJob[];
  hourOverride?: number;
  diskHeld: () => boolean;
  now: () => Date;
  loadState: () => Record<string, string>;
  saveState: (s: Record<string, string>) => void;
  hasSession: (name: string) => boolean;
  listSessions: () => string[];
  branchFor: (job: SelfImproveJob, now: Date) => string;
  // Branch of an existing worktree for this job (a live run, or a dead run's leftover), if any.
  existingBranch: (job: SelfImproveJob) => string | null;
  prForBranch: (branch: string) => Promise<number | null>;
  openSelfImprovePrs: () => Promise<number>;
  spawn: (job: SelfImproveJob, branch: string) => void;
  kill: (name: string) => void;
  removeWorktree: (branch: string, deleteBranch: boolean) => void;
  markStarted: (job: SelfImproveJob) => void;
  markDone: (job: SelfImproveJob, pr: number | null) => void;
  reapStaleMs: number;
  log: (msg: string) => void;
};

export type SelfImproveState = { inFlight: Map<string, { branch: string; startedAt: number }> };

export function freshSelfImproveState(): SelfImproveState {
  return { inFlight: new Map() };
}

const PREFIX = "self-improve-";

export function selfImproveSessionName(jobId: string): string {
  return `${PREFIX}${jobId}`;
}

function adoptLiveSessions(state: SelfImproveState, deps: SelfImproveDeps): void {
  for (const name of deps.listSessions()) {
    if (!name.startsWith(PREFIX)) continue;
    const job = deps.jobs.find((j) => j.id === name.slice(PREFIX.length));
    if (!job || state.inFlight.has(job.id)) continue;
    const now = deps.now();
    state.inFlight.set(job.id, { branch: deps.existingBranch(job) ?? deps.branchFor(job, now), startedAt: now.getTime() });
  }
}

// Returns false when a lookup failed and the tick should stop.
async function sweepInFlight(state: SelfImproveState, deps: SelfImproveDeps): Promise<boolean> {
  for (const [jobId, run] of [...state.inFlight]) {
    const job = deps.jobs.find((j) => j.id === jobId);
    if (!job) continue;
    const name = selfImproveSessionName(jobId);
    let pr: number | null;
    try {
      pr = await deps.prForBranch(run.branch);
    } catch (err) {
      deps.log(`self-improve: PR lookup failed for ${jobId}: ${err}`);
      return false;
    }
    if (pr !== null) {
      deps.kill(name);
      deps.removeWorktree(run.branch, false);
      deps.markDone(job, pr);
      state.inFlight.delete(jobId);
      deps.log(`${jobId}: opened PR #${pr}`);
      continue;
    }
    if (!deps.hasSession(name)) {
      deps.removeWorktree(run.branch, true);
      deps.markDone(job, null);
      state.inFlight.delete(jobId);
      deps.log(`${jobId}: nothing to change`);
      continue;
    }
    if (deps.now().getTime() - run.startedAt > deps.reapStaleMs) {
      deps.kill(name);
      deps.removeWorktree(run.branch, true);
      deps.markDone(job, null);
      state.inFlight.delete(jobId);
      deps.log(`${jobId}: reaped stale session`);
    }
  }
  return true;
}

async function canSpawn(state: SelfImproveState, deps: SelfImproveDeps): Promise<boolean> {
  if (state.inFlight.size > 0 || deps.diskHeld()) return false;
  try {
    return (await deps.openSelfImprovePrs()) === 0;
  } catch (err) {
    deps.log(`self-improve: open PR lookup failed: ${err}`);
    return false;
  }
}

// A dead run (tmux gone, reboot) leaves its worktree at the job's fixed path, which
// would make every later launch fail. Returns false when it could not be cleared.
async function clearLeftover(job: SelfImproveJob, deps: SelfImproveDeps): Promise<boolean> {
  const leftover = deps.existingBranch(job);
  if (!leftover) return true;
  try {
    const pr = await deps.prForBranch(leftover);
    deps.removeWorktree(leftover, pr === null);
    deps.log(`${job.id}: cleared leftover worktree for ${leftover}`);
    return true;
  } catch (err) {
    deps.log(`self-improve: could not clear leftover worktree for ${job.id}: ${err}`);
    return false;
  }
}

async function spawnFirstDue(state: SelfImproveState, deps: SelfImproveDeps): Promise<void> {
  const now = deps.now();
  const lastRun = deps.loadState();
  const job = deps.jobs.find((j) => deps.jobEnabled(j) && isDue(j, lastRun[j.id], now, deps.hourOverride));
  if (!job) return;
  if (!(await clearLeftover(job, deps))) return;
  const branch = deps.branchFor(job, now);
  try {
    deps.spawn(job, branch);
  } catch (err) {
    deps.log(`self-improve: failed to start ${job.id}: ${err}`);
    return;
  }
  deps.saveState({ ...lastRun, [job.id]: periodKey(job, now) });
  state.inFlight.set(job.id, { branch, startedAt: now.getTime() });
  deps.markStarted(job);
  deps.log(`${job.id}: started`);
}

export async function selfImproveOnce(state: SelfImproveState, deps: SelfImproveDeps): Promise<void> {
  if (!deps.enabled()) return;
  adoptLiveSessions(state, deps);
  if (!(await sweepInFlight(state, deps))) return;
  if (!(await canSpawn(state, deps))) return;
  await spawnFirstDue(state, deps);
}
