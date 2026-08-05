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
  // Report the classified verdict each tick (never for a hold). Lets the board
  // reflect observed readiness independent of whether a label write happened, so
  // a PR that is ready but already labeled still surfaces as ready-to-merge.
  onVerdict?: (prNumber: number, verdict: ReadyVerdict) => void;
  // The label name to keep in sync (e.g. "ready-to-merge").
  label: string;
  log: (msg: string) => void;
};

// Three outcomes that drive the ready label:
//   ready     - every thread resolved, mergeable, CI green (or none): add the label.
//   regressed - a hard failure (unresolved thread, merge conflict, or failing CI):
//               the label must come off.
//   hold      - neither: a still-running CI check or GitHub's not-yet-computed
//               mergeable state. Leave the label exactly as it is.
// The `hold` state is what lets the label coexist with a merge queue: once the
// label triggers the queue, the queue rebases the branch and re-runs CI, which
// reads back as pending/unknown for a spell. Treating that as `hold` (not
// `regressed`) keeps the label on, so the PR is never yanked back out of the
// queue mid-merge. The queue's own gating check is excluded upstream in
// `checksInfo`, so it never keeps CI perpetually pending here.
export type ReadyVerdict = "ready" | "regressed" | "hold";

// Reads short-circuit in cheap-first order (an unresolved thread returns before
// the mergeable/CI reads), so a regressed PR costs the fewest gh calls. A read
// rejecting propagates to readyOnce, which skips the PR for this tick.
async function classify(prNumber: number, deps: PrReadyDeps): Promise<ReadyVerdict> {
  if ((await deps.unresolvedInfo(prNumber)).count !== 0) return "regressed";
  const mergeable = (await deps.mergeableInfo(prNumber)).state;
  if (mergeable === "conflicting") return "regressed";
  if (mergeable === "unknown") return "hold";
  const ci = (await deps.checksInfo(prNumber)).state;
  if (ci === "failing") return "regressed";
  if (ci === "pending") return "hold";
  return "ready"; // passing or none
}

// One ready-step tick, run every heartbeat. For each non-draft open PR, keep the
// ready label in sync with its readiness: add it when the PR is ready and lacks
// it, remove it on a hard regression when it carries it, and otherwise leave it
// alone. Stateless: it reconciles against GitHub's live label state every tick,
// so it self-corrects across restarts and only ever writes on a real delta. A
// readiness read that errors skips the PR for this tick (label left untouched); a
// label add/remove that errors is logged and the loop continues.
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

    let verdict: ReadyVerdict;
    try {
      verdict = await classify(pr.number, deps);
    } catch (err) {
      deps.log(`readiness check failed for PR #${pr.number}: ${err}`);
      continue;
    }
    if (verdict === "hold") continue; // neither add nor remove: skip the label read entirely
    deps.onVerdict?.(pr.number, verdict);

    let labels: string[];
    try {
      labels = await deps.prLabels(pr.number);
    } catch (err) {
      deps.log(`label read failed for PR #${pr.number}: ${err}`);
      continue;
    }
    const hasLabel = labels.includes(deps.label);

    if (verdict === "ready" && !hasLabel) {
      try {
        await deps.addLabel(pr.number, deps.label);
        deps.log(`labeled PR #${pr.number} ${deps.label} (ready to merge)`);
      } catch (err) {
        deps.log(`add label failed for PR #${pr.number}: ${err}`);
      }
    } else if (verdict === "regressed" && hasLabel) {
      try {
        await deps.removeLabel(pr.number, deps.label);
        deps.log(`removed ${deps.label} from PR #${pr.number} (no longer ready)`);
      } catch (err) {
        deps.log(`remove label failed for PR #${pr.number}: ${err}`);
      }
    }
  }
}
