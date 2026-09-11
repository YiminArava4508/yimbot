// src/held-merged.ts
// The board row keys of merged worktrees the cleanup step is holding this
// tick (a sibling PR still open in another repo, or the ticket not landed in
// Linear), refreshed each heartbeat and read by the TUI at paint time so the
// row reads "merged, waiting on ticket" instead of "working (manual)".
//
// Process-local like open-prs.ts: a cache of a live answer, never persisted.
let keys = new Set<string>();

export function setHeldMergedKeys(next: Set<string>): void {
  keys = new Set(next);
}

export function heldMergedKeys(): Set<string> {
  return new Set(keys);
}
