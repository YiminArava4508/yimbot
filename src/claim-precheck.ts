// src/claim-precheck.ts
// A flag-archive ticket's Linear blockers being Done only means the removal
// merged; prod may still run code that reads the flag. Claiming it then just
// parks a session on a needs-decision hand-back that holds a WIP slot. So before
// the claim step takes an "Archive `<key>` flag ..." ticket it runs the
// reference checks (flag-archive checks 2 and 3) and leaves the ticket in Todo
// until they pass. Results are cached per ticket so the git and GitHub work
// runs at most once per TTL, not on every heartbeat.

// The key of an "Archive `<key>` flag in prod" ticket, or null for any other
// title. Stricter than flagKeyFromTitle: one backticked name anywhere is not
// enough, the title has to be an archive-flag title.
export function archiveFlagKey(title: string): string | null {
  const m = /^\s*archive\s+`([A-Za-z0-9._-]+)`\s+flag\b/i.exec(title);
  return m ? m[1]! : null;
}

export type PrecheckResult = { pass: boolean; detail: string };

// issue id -> the last result and when it was taken.
// errored: the check threw rather than answered, so it is retried sooner.
export type PrecheckCache = Map<string, { at: number; result: PrecheckResult; errored: boolean }>;

export type PrecheckDeps = {
  check: (key: string) => Promise<PrecheckResult>;
  cache: PrecheckCache;
  // How long a result stands before the check runs again.
  ttlMs: number;
  // A check that threw (lock contention, GitHub hiccup) is retried sooner.
  errorTtlMs: number;
  now: () => number;
  log: (msg: string) => void;
};

type Candidate = { id: string; identifier: string; title: string };

// The first `need` candidates, in order, that are either not archive-flag
// tickets or whose reference checks pass. A failing archive ticket is skipped
// (logged once per fresh result) so it does not use up this tick's slot.
export async function filterArchiveReady<T extends Candidate>(candidates: T[], need: number, deps: PrecheckDeps): Promise<T[]> {
  const ready: T[] = [];
  for (const c of candidates) {
    if (ready.length >= need) break;
    const key = archiveFlagKey(c.title);
    if (!key) {
      ready.push(c);
      continue;
    }
    const now = deps.now();
    const cached = deps.cache.get(c.id);
    const fresh = cached && now - cached.at < (cached.errored ? deps.errorTtlMs : deps.ttlMs);
    let result: PrecheckResult;
    if (fresh) {
      result = cached!.result;
    } else {
      let errored = false;
      try {
        result = await deps.check(key);
      } catch (err) {
        errored = true;
        result = { pass: false, detail: `precheck error: ${err}` };
      }
      deps.cache.set(c.id, { at: now, result, errored });
      if (!result.pass) deps.log(`deferring ${c.identifier}: flag-archive precheck for ${key} failed (${result.detail})`);
    }
    if (result.pass) ready.push(c);
  }
  return ready;
}
