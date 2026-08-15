import { createSubIssue, fetchIssueSplitInfo, fetchTeamStates, setIssueEstimate } from "./linear-api.ts";

// Mirrors the worktree-dir sanitation in split-pr.sh (alnum/dash, 50 chars) so
// the branch, worktree dir, and tmux session all share one name.
export function sliceBranchName(identifier: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const branch = slug ? `${identifier.toLowerCase()}-${slug}` : identifier.toLowerCase();
  return branch.slice(0, 50).replace(/-+$/, "");
}

export type SliceSubticket = { identifier: string; branch: string };

export type SliceOptions = {
  points?: number;
  claimable?: boolean;
  todoStateName?: string;
  zeroParent?: boolean;
};

// Create one split-slice subticket under a parent ticket: a Linear sub-issue
// inheriting the parent's assignee, with the parent's own estimate zeroed so
// points live only on the slices. With `claimable`, the sub-issue lands in
// the team's Todo state and the active cycle instead of Linear's default
// (Backlog, no cycle) and inherits the parent's labels, so the claim step can
// pick it up with the parent's risk-label and LABEL_FILTER gating intact.
// `zeroParent: false` leaves the parent's estimate alone: a multi-slice
// decomposition zeroes it once, itself, after the last slice, since a non-null
// parent estimate is what tells the refine step the work is done.
export async function createSliceSubticket(
  apiKey: string,
  parentIdentifier: string,
  title: string,
  opts: SliceOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<SliceSubticket> {
  const parent = await fetchIssueSplitInfo(apiKey, parentIdentifier, fetchImpl);
  let placement: { stateId?: string; cycleId?: string; labelIds?: string[] } = {};
  if (opts.claimable) {
    const wanted = opts.todoStateName ?? "Todo";
    const states = await fetchTeamStates(apiKey, parent.teamId, fetchImpl);
    const todo = states.find((s) => s.name.toLowerCase() === wanted.toLowerCase());
    if (!todo) throw new Error(`Team of ${parentIdentifier} has no state named "${wanted}"`);
    placement = {
      stateId: todo.id,
      ...(parent.activeCycleId ? { cycleId: parent.activeCycleId } : {}),
      ...(parent.labelIds.length ? { labelIds: parent.labelIds } : {}),
    };
  }
  const created = await createSubIssue(
    apiKey,
    {
      teamId: parent.teamId,
      parentId: parent.id,
      title,
      ...(opts.points != null ? { estimate: opts.points } : {}),
      ...(parent.assigneeId ? { assigneeId: parent.assigneeId } : {}),
      ...placement,
    },
    fetchImpl,
  );
  if (opts.zeroParent !== false) await setIssueEstimate(apiKey, parent.id, 0, fetchImpl);
  return { identifier: created.identifier, branch: sliceBranchName(created.identifier, title) };
}
