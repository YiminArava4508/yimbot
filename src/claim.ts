import type { CycleTodoIssue } from "./linear-api.ts";

export type SelectOptions = {
  // Label names (any casing) that disqualify a ticket from being claimed.
  riskLabels: string[];
};

// Linear's `priority` is inverted (0=None, 1=Urgent … 4=Low). Rank it so
// Urgent sorts first and None sorts last, regardless of the numeric value.
function priorityRank(priority: number): number {
  return priority === 0 ? Number.POSITIVE_INFINITY : priority;
}

// Choose the next Todo ticket to claim: drop risk-labeled tickets, then order
// by priority (Urgent first, None last), breaking ties on the manual cycle
// order. Returns null when nothing qualifies.
export function selectNextClaim(
  todos: CycleTodoIssue[],
  opts: SelectOptions,
): CycleTodoIssue | null {
  const risky = new Set(opts.riskLabels.map((l) => l.toLowerCase()));
  const eligible = todos.filter(
    (t) => !t.labels.some((label) => risky.has(label.toLowerCase())),
  );
  eligible.sort(
    (a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.sortOrder - b.sortOrder,
  );
  return eligible[0] ?? null;
}
