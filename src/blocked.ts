import type { MergedPR } from "./gh.ts";

const IDENTIFIER_RE = /^[a-z]+-\d+/;

// One ticket this ticket is blocked by, with the Linear workflow state it sits
// in. The state is what decides whether its work has landed.
export type Blocker = {
  identifier: string;
  stateName: string;
  // Linear's state type: "triage", "backlog", "unstarted", "started",
  // "completed", "canceled" or "duplicate".
  stateType: string;
};

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

// The started-type state names that mean a blocker's work has landed, lowercased
// for matching: the merge state and the post-merge review state. Every
// completed/canceled state counts too, but by type rather than by name.
export function clearedStateNames(mergedStateName: string, reviewStateName: string): Set<string> {
  return new Set(
    [mergedStateName, reviewStateName].map((n) => n.trim().toLowerCase()).filter(Boolean),
  );
}

// A blocker stops blocking once its work has landed: it reached the merge state
// (or one past it), it was closed out, or its PR is merged even though nobody
// moved the ticket.
function isSatisfied(b: Blocker, merged: Set<string>, cleared: Set<string>): boolean {
  return (
    cleared.has(b.stateName.trim().toLowerCase()) ||
    b.stateType === "completed" ||
    b.stateType === "canceled" ||
    b.stateType === "duplicate" ||
    merged.has(b.identifier.toUpperCase())
  );
}

// A ticket is blocked while any of its blockers is unsatisfied. No blockers
// means never blocked.
export function isBlocked(
  blockedBy: Blocker[],
  merged: Set<string>,
  cleared: Set<string>,
): boolean {
  return blockedBy.some((b) => !isSatisfied(b, merged, cleared));
}

// The blockers still holding a ticket back, each with its current state, for the
// log line that explains a deferral.
export function unsatisfiedBlockers(
  blockedBy: Blocker[],
  merged: Set<string>,
  cleared: Set<string>,
): string {
  return blockedBy
    .filter((b) => !isSatisfied(b, merged, cleared))
    .map((b) => `${b.identifier} (${b.stateName})`)
    .join(", ");
}
