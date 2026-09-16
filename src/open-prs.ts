// src/open-prs.ts
// The board row keys of the instance's open PRs, refreshed by the review step
// each heartbeat and read by the TUI at paint time.
//
// The board needs to know a row's work still exists. For a PR-backed row that
// fact is "the PR is open", not "a worktree exists on this machine": a split
// slice whose worktree was never created, or a session reaped before merge,
// leaves an open PR with nothing local behind it, and the row has to stay
// visible so the operator can still review or queue it.
//
// Process-local and deliberately not persisted: it is a cache of a live gh
// answer, and a stale one read from disk at startup would resurrect rows for
// PRs that have since merged.
let keys = new Set<string>();

// Called only after a successful PR list, so a gh failure leaves the last good
// set in place rather than blanking every worktree-less row for a heartbeat.
export function setOpenPrKeys(next: Set<string>): void {
  keys = new Set(next);
}

export function openPrKeys(): Set<string> {
  return new Set(keys);
}
