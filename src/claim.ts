import { isBlocked } from "./blocked.ts";
import { hasLabel, labelFilterAllows, type LabelFilter } from "./labels.ts";
import type { CycleTodoIssue } from "./linear-api.ts";

export type SelectOptions = {
  // Label names (any casing) that disqualify a ticket from being claimed.
  riskLabels: string[];
  // Label (any casing) a rejected ticket carries; such tickets are never claimed.
  rejectLabel: string;
  // Label (any casing) that makes a ticket wait for its blockers to be completed, not merely merged.
  afterReleaseLabel: string;
  // Merged ticket identifiers. When non-null, todos with a blocker whose work
  // has not landed are dropped; null skips the blocked filter (gh unavailable).
  merged: Set<string> | null;
  // State names that count as a blocker's work having landed (clearedStateNames).
  clearedStates: Set<string>;
  // Which slice of the board this instance works (LABEL_FILTER).
  labelFilter: LabelFilter;
  // Skip unestimated tickets (they are the refine step's to size first). Zero
  // estimates are skipped unconditionally: a 0-point ticket is a decomposed
  // container whose subtickets carry the work.
  requireEstimate: boolean;
  // Inclusive estimate ceiling (MAX_ESTIMATE); null claims any size. Unestimated
  // tickets are exempt: requireEstimate owns those.
  maxEstimate: number | null;
};

// Parse MAX_ESTIMATE: a positive integer caps claims at that estimate; empty,
// non-numeric or non-positive values all mean no cap.
export function parseMaxEstimate(raw: string | undefined): number | null {
  const n = Number(raw?.trim() || undefined);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

// Linear's `priority` is inverted (0=None, 1=Urgent … 4=Low). Rank it so
// Urgent sorts first and None sorts last, regardless of the numeric value.
function priorityRank(priority: number): number {
  return priority === 0 ? Number.POSITIVE_INFINITY : priority;
}

// An after-release ticket is gated on blocker state alone, so it is checked even
// when the merged-PR list is unavailable.
function isHeldByBlockers(t: CycleTodoIssue, opts: SelectOptions): boolean {
  const afterRelease = hasLabel(t.labels, opts.afterReleaseLabel);
  if (!afterRelease && opts.merged === null) return false;
  return isBlocked(t.blockedBy, opts.merged ?? new Set(), opts.clearedStates, afterRelease);
}

// Rank the Todo tickets that may be claimed: drop risk-labeled tickets, then
// order by priority (Urgent first, None last), breaking ties on the manual
// cycle order.
export function selectClaims(todos: CycleTodoIssue[], opts: SelectOptions): CycleTodoIssue[] {
  const risky = new Set(opts.riskLabels.map((l) => l.toLowerCase()));
  const eligible = todos.filter(
    (t) =>
      labelFilterAllows(opts.labelFilter, t.labels) &&
      !t.labels.some((label) => risky.has(label.toLowerCase())) &&
      !hasLabel(t.labels, opts.rejectLabel) &&
      !isHeldByBlockers(t, opts) &&
      t.estimate !== 0 &&
      !(opts.requireEstimate && t.estimate === null) &&
      !(opts.maxEstimate !== null && t.estimate !== null && t.estimate > opts.maxEstimate),
  );
  return eligible.sort(
    (a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.sortOrder - b.sortOrder,
  );
}

// The next ticket to claim, or null when nothing qualifies.
export function selectNextClaim(
  todos: CycleTodoIssue[],
  opts: SelectOptions,
): CycleTodoIssue | null {
  return selectClaims(todos, opts)[0] ?? null;
}
