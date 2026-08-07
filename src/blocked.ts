import type { MergedPR } from "./gh.ts";

// The ticket identifier at the head of a branch slug (eng-1104, sc-42).
const IDENTIFIER_RE = /^[a-z]+-\d+/;

// Uppercase ticket identifiers parsed from merged PR branches. Branches with no
// leading identifier are ignored.
export function mergedIdentifierSet(mergedPRs: MergedPR[]): Set<string> {
  const set = new Set<string>();
  for (const pr of mergedPRs) {
    const m = IDENTIFIER_RE.exec(pr.headRefName.toLowerCase());
    if (m) set.add(m[0].toUpperCase());
  }
  return set;
}

// A ticket is blocked while any ticket it is blocked by is absent from the
// merged set. No blockers means never blocked.
export function isBlocked(blockedBy: string[], merged: Set<string>): boolean {
  return blockedBy.some((id) => !merged.has(id.toUpperCase()));
}
