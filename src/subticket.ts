import { createSubIssue, fetchIssueSplitInfo, setIssueEstimate } from "./linear-api.ts";

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

// Create one split-slice subticket under a parent ticket: a Linear sub-issue
// inheriting the parent's assignee, with the parent's own estimate zeroed so
// points live only on the slices.
export async function createSliceSubticket(
  apiKey: string,
  parentIdentifier: string,
  title: string,
  points?: number,
  fetchImpl: typeof fetch = fetch,
): Promise<SliceSubticket> {
  const parent = await fetchIssueSplitInfo(apiKey, parentIdentifier, fetchImpl);
  const created = await createSubIssue(
    apiKey,
    {
      teamId: parent.teamId,
      parentId: parent.id,
      title,
      ...(points != null ? { estimate: points } : {}),
      ...(parent.assigneeId ? { assigneeId: parent.assigneeId } : {}),
    },
    fetchImpl,
  );
  await setIssueEstimate(apiKey, parent.id, 0, fetchImpl);
  return { identifier: created.identifier, branch: sliceBranchName(created.identifier, title) };
}
