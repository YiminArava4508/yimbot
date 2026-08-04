import type { ChecksInfo, MergeableInfo, OpenPR, UnresolvedInfo } from "./gh.ts";

export type PrReadyDeps = {
  // The viewer's open PRs (drafts included; filtered here).
  listOpenPRs: () => Promise<OpenPR[]>;
  // Unresolved-thread summary for a PR: count + newest other-authored comment ms.
  unresolvedInfo: (prNumber: number) => Promise<UnresolvedInfo>;
  // Mergeability summary for a PR: conflicting/mergeable/unknown + head SHA.
  mergeableInfo: (prNumber: number) => Promise<MergeableInfo>;
  // CI summary for a PR: rollup state + head SHA.
  checksInfo: (prNumber: number) => Promise<ChecksInfo>;
  // The label names currently on a PR.
  prLabels: (prNumber: number) => Promise<string[]>;
  // Add / remove the ready label on a PR.
  addLabel: (prNumber: number, label: string) => Promise<void>;
  removeLabel: (prNumber: number, label: string) => Promise<void>;
  // The label name to keep in sync (e.g. "ready-to-merge").
  label: string;
  log: (msg: string) => void;
};

// A PR is ready to merge when every review thread is resolved, it is positively
// mergeable, and CI is green (or there is no CI at all). Reads short-circuit in
// cheap-first order (an unresolved thread returns before the mergeable/CI
// reads), so a not-ready PR costs the fewest gh calls. A read rejecting propagates to
// readyOnce, which skips the PR for this tick.
async function isReady(prNumber: number, deps: PrReadyDeps): Promise<boolean> {
  if ((await deps.unresolvedInfo(prNumber)).count !== 0) return false;
  if ((await deps.mergeableInfo(prNumber)).state !== "mergeable") return false;
  const ci = (await deps.checksInfo(prNumber)).state;
  return ci === "passing" || ci === "none";
}

// One ready-step tick, run every heartbeat. For each non-draft open PR, keep the
// ready label in sync with its readiness: add it when the PR is ready and lacks
// it, remove it when the PR is not ready and carries it, and otherwise do
// nothing. Stateless: it reconciles against GitHub's live label state every
// tick, so it self-corrects across restarts and only ever writes on a real
// delta. A readiness read that errors skips the PR for this tick (label left
// untouched); a label add/remove that errors is logged and the loop continues.
export async function readyOnce(deps: PrReadyDeps): Promise<void> {
  let prs: OpenPR[];
  try {
    prs = await deps.listOpenPRs();
  } catch (err) {
    deps.log(`pr list failed: ${err}`);
    return;
  }

  for (const pr of prs) {
    if (pr.isDraft) continue;

    let ready: boolean;
    try {
      ready = await isReady(pr.number, deps);
    } catch (err) {
      deps.log(`readiness check failed for PR #${pr.number}: ${err}`);
      continue;
    }

    let labels: string[];
    try {
      labels = await deps.prLabels(pr.number);
    } catch (err) {
      deps.log(`label read failed for PR #${pr.number}: ${err}`);
      continue;
    }
    const hasLabel = labels.includes(deps.label);

    if (ready && !hasLabel) {
      try {
        await deps.addLabel(pr.number, deps.label);
        deps.log(`labeled PR #${pr.number} ${deps.label} (ready to merge)`);
      } catch (err) {
        deps.log(`add label failed for PR #${pr.number}: ${err}`);
      }
    } else if (!ready && hasLabel) {
      try {
        await deps.removeLabel(pr.number, deps.label);
        deps.log(`removed ${deps.label} from PR #${pr.number} (no longer ready)`);
      } catch (err) {
        deps.log(`remove label failed for PR #${pr.number}: ${err}`);
      }
    }
  }
}
