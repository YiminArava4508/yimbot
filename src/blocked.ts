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

// True when a ticket state name is the merge state or one past it.
export function isClearedState(stateName: string, cleared: Set<string>): boolean {
  return cleared.has(stateName.trim().toLowerCase());
}

// A blocker stops blocking once its work has landed: it reached the merge state
// (or one past it), it was closed out, or its PR is merged even though nobody
// moved the ticket. An after-release ticket (doneState set) waits for the
// blocker to sit in the Done state by name: merged work has not shipped yet, and
// other completed-type states such as Ready To Release are not released either.
function isSatisfied(
  b: Blocker,
  merged: Set<string>,
  cleared: Set<string>,
  doneState: string | null,
): boolean {
  if (doneState !== null) return isClearedState(b.stateName, new Set([doneState.trim().toLowerCase()]));
  return (
    isClearedState(b.stateName, cleared) ||
    b.stateType === "completed" ||
    b.stateType === "canceled" ||
    b.stateType === "duplicate" ||
    merged.has(b.identifier.toUpperCase())
  );
}

// An after-release ticket with nothing to wait on is almost always a mistake, so
// it is never claimable.
export function isAfterReleaseOrphan(afterRelease: boolean, blockedBy: Blocker[]): boolean {
  return afterRelease && blockedBy.length === 0;
}

// A ticket is blocked while any of its blockers is unsatisfied. No blockers
// means never blocked, except for an after-release ticket (doneState set).
export function isBlocked(
  blockedBy: Blocker[],
  merged: Set<string>,
  cleared: Set<string>,
  doneState: string | null = null,
): boolean {
  return (
    isAfterReleaseOrphan(doneState !== null, blockedBy) ||
    blockedBy.some((b) => !isSatisfied(b, merged, cleared, doneState))
  );
}

// The blockers still holding a ticket back, each with its current state, for the
// log line that explains a deferral.
export function unsatisfiedBlockers(
  blockedBy: Blocker[],
  merged: Set<string>,
  cleared: Set<string>,
  doneState: string | null = null,
): string {
  const suffix = doneState !== null ? ", waiting for release" : "";
  return blockedBy
    .filter((b) => !isSatisfied(b, merged, cleared, doneState))
    .map((b) => `${b.identifier} (${b.stateName}${suffix})`)
    .join(", ");
}
