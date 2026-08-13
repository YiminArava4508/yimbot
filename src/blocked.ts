import type { MergedPR } from "./gh.ts";

const IDENTIFIER_RE = /^[a-z]+-\d+/;

// The ticket identifier at the head of a branch slug (eng-1104 -> ENG-1104).
// Null when the branch does not start with one.
export function ticketIdentifierFromBranch(branch: string): string | null {
  const m = IDENTIFIER_RE.exec(branch.toLowerCase());
  return m ? m[0].toUpperCase() : null;
}

// Uppercase ticket identifiers parsed from merged PR branches. Branches with no
// leading identifier are ignored.
export function mergedIdentifierSet(mergedPRs: MergedPR[]): Set<string> {
  const set = new Set<string>();
  for (const pr of mergedPRs) {
    const id = ticketIdentifierFromBranch(pr.headRefName);
    if (id) set.add(id);
  }
  return set;
}

// A ticket is blocked while any ticket it is blocked by is absent from the
// merged set. No blockers means never blocked.
export function isBlocked(blockedBy: string[], merged: Set<string>): boolean {
  return blockedBy.some((id) => !merged.has(id.toUpperCase()));
}
