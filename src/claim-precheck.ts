// src/claim-precheck.ts
// A flag-archive ticket's Linear blockers being Done only means the removal
// merged; prod may still run code that reads the flag. Claiming it then just
// parks a session on a needs-decision hand-back that holds a WIP slot. So before
// the claim step takes an "Archive `<key>` flag ..." ticket it runs the
// reference checks (flag-archive checks 2 and 3) and leaves the ticket in Todo
// until they pass. Results are cached per ticket so the git and GitHub work
// runs at most once per TTL, not on every heartbeat.
import { COULD_NOT_RUN, type Check, type FlagArchiveReport } from "./flag-archive.ts";

// The key of an "Archive `<key>` flag in prod" ticket, or null for any other
// title. Stricter than flagKeyFromTitle: one backticked name anywhere is not
// enough, the title has to be an archive-flag title.
export function archiveFlagKey(title: string): string | null {
  const m = /^\s*archive\s+`([A-Za-z0-9._-]+)`\s+flag\b/i.exec(title);
  return m ? m[1]! : null;
}

export type PrecheckResult = { pass: boolean; detail: string };

// errored: the check threw rather than answered, so it is retried sooner.
type PrecheckEntry = { at: number; result: PrecheckResult; errored: boolean };

export type PrecheckState = {
  // issue id -> the last result and when it was taken.
  results: Map<string, PrecheckEntry>;
  // The one check in flight. Checks run one at a time and off the heartbeat:
  // each fetches gemini and greps every prod build, which takes too long to
  // hold the claim step for.
  running: Promise<void> | null;
};

export function freshPrecheckState(): PrecheckState {
  return { results: new Map(), running: null };
}

export type PrecheckDeps = {
  check: (key: string) => Promise<PrecheckResult>;
  state: PrecheckState;
  // How long a result stands before the check runs again.
  ttlMs: number;
  // A check that threw (lock contention, GitHub hiccup) is retried sooner.
  errorTtlMs: number;
  now: () => number;
  log: (msg: string) => void;
};

type Candidate = { id: string; identifier: string; title: string };

// Turns a flag-archive report into a precheck result. A check that could not
// run throws, so the caller retries it on the short error TTL, unless another
// check already found a real reference.
export function summarizeReport(report: Pick<FlagArchiveReport, "pass" | "checks">): PrecheckResult {
  if (report.pass) return { pass: true, detail: "reference checks pass" };
  const failed = report.checks.filter((c) => !c.pass);
  const line = (c: Check) => `${c.name}: ${c.detail}`;
  const unreadable = (c: Check) => c.detail.startsWith(COULD_NOT_RUN);
  if (failed.every(unreadable)) throw new Error(failed.map(line).join("; "));
  return { pass: false, detail: failed.filter((c) => !unreadable(c)).map(line).join("; ").slice(0, 400) };
}

const isFresh = (e: PrecheckEntry, now: number, deps: PrecheckDeps) => now - e.at < (e.errored ? deps.errorTtlMs : deps.ttlMs);

async function runCheck(c: Candidate, key: string, deps: PrecheckDeps): Promise<void> {
  let result: PrecheckResult;
  let errored = false;
  try {
    result = await deps.check(key);
  } catch (err) {
    errored = true;
    result = { pass: false, detail: `precheck error: ${err}` };
  }
  deps.state.results.set(c.id, { at: deps.now(), result, errored });
  if (!result.pass) deps.log(`deferring ${c.identifier}: flag-archive precheck for ${key} failed (${result.detail})`);
}

// The first `need` candidates, in order, that are either not archive-flag
// tickets or whose reference checks passed recently. An archive ticket with no
// fresh result is skipped this heartbeat and its check started in the
// background (if none is running), so it never holds up the claim step or
// uses up this tick's slot.
export function filterArchiveReady<T extends Candidate>(candidates: T[], need: number, deps: PrecheckDeps): T[] {
  const now = deps.now();
  for (const [id, e] of deps.state.results) if (!isFresh(e, now, deps)) deps.state.results.delete(id);
  const ready: T[] = [];
  for (const c of candidates) {
    if (ready.length >= need) break;
    const key = archiveFlagKey(c.title);
    if (!key) {
      ready.push(c);
      continue;
    }
    const cached = deps.state.results.get(c.id);
    if (cached) {
      if (cached.result.pass) ready.push(c);
      continue;
    }
    if (deps.state.running) continue;
    deps.state.running = runCheck(c, key, deps).finally(() => {
      deps.state.running = null;
    });
  }
  return ready;
}
