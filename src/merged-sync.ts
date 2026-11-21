import { ticketIdentifierFromBranch } from "./blocked.ts";
import type { MergedPR, OpenPR } from "./gh.ts";

export type MergedSyncDeps = {
  listMergedPRs: () => Promise<MergedPR[]>;
  listOpenPRs: () => Promise<OpenPR[]>;
  // The viewer's review-state tickets, already label-filtered.
  listReviewIssues: () => Promise<{ identifier: string }[]>;
  fetchState: (identifier: string) => Promise<string>;
  moveToMerged: (identifier: string) => Promise<void>;
  reviewStateName: string;
  mergedStateName: string;
  graceMs: number;
  now: () => number;
  log: (msg: string) => void;
};

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// Backstop for the Linear GitHub integration: it only moves a ticket on merge
// when the PR body has a closing word. Moves review-state tickets whose PRs have
// all merged (and aged past the grace period) to the merged state.
export async function mergedSyncOnce(deps: MergedSyncDeps): Promise<void> {
  let merged: MergedPR[];
  let open: OpenPR[];
  let issues: { identifier: string }[];
  try {
    [merged, open, issues] = await Promise.all([deps.listMergedPRs(), deps.listOpenPRs(), deps.listReviewIssues()]);
  } catch (err) {
    deps.log(`[merged-sync] list failed: ${err}`);
    return;
  }

  const openIds = new Set<string>();
  for (const pr of open) {
    const id = ticketIdentifierFromBranch(pr.headRefName);
    if (id) openIds.add(id);
  }

  const mergedByTicket = new Map<string, MergedPR[]>();
  for (const pr of merged) {
    const id = ticketIdentifierFromBranch(pr.headRefName);
    if (!id) continue;
    mergedByTicket.set(id, [...(mergedByTicket.get(id) ?? []), pr]);
  }

  const cutoff = deps.now() - deps.graceMs;
  const settled = (prs: MergedPR[]) =>
    prs.every((pr) => pr.mergedAt !== undefined && Date.parse(pr.mergedAt) <= cutoff);

  for (const { identifier } of issues) {
    const prs = mergedByTicket.get(identifier);
    if (!prs || openIds.has(identifier) || !settled(prs)) continue;
    try {
      if (!same(await deps.fetchState(identifier), deps.reviewStateName)) continue;
      await deps.moveToMerged(identifier);
      const newest = prs.reduce((a, b) => (Date.parse(b.mergedAt!) > Date.parse(a.mergedAt!) ? b : a));
      deps.log(
        `[merged-sync] moved ${identifier} ${deps.reviewStateName} -> ${deps.mergedStateName} (PR #${newest.number} merged)`,
      );
    } catch (err) {
      deps.log(`[merged-sync] failed to move ${identifier}: ${err}`);
    }
  }
}
