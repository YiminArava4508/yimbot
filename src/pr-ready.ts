import type { ChecksInfo, MergeableInfo, OpenPR, UnresolvedInfo } from "./gh.ts";

export type PrReadyDeps = {
  // The viewer's open PRs, drafts included.
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
  // The merge-queue "blocked" label. A PR carrying it is owned by the blocked-fix
  // flow, so the ready step leaves its labels untouched (never re-queues it).
  blockedLabel: string;
  // Report the classified verdict each tick, for a PR the ready step owns (any
  // verdict except a blocked PR, whose labels the blocked-fix flow owns). Carries
  // `hasLabel` (does the PR already carry the ready label) so the board can reflect
  // observed readiness independent of whether a label write happened: a PR that is
  // ready but already labeled still surfaces as ready-to-merge, and a queued PR
  // sitting in `hold` with the label surfaces as ready-to-merge too (rather than
  // stalling on whatever fix status last touched its row). Carries `isDraft` so
  // the board can say "draft pr" instead of "ready to merge" while a supervised
  // draft waits for a human to mark it ready for review.
  onVerdict?: (prNumber: number, verdict: ReadyVerdict, hasLabel: boolean, isDraft: boolean) => void;
  log: (msg: string) => void;
};

// Three outcomes that drive the ready label:
//   ready     - every thread resolved, mergeable, CI green (or none): add the label.
//   regressed - a hard failure (unresolved thread or failing CI): the label must
//               come off.
//   hold      - neither: a still-running CI check, GitHub's not-yet-computed
//               mergeable state, or a merge conflict (the label-driven conflict
//               sweep heals those). Leave the label exactly as it is.
// The `hold` state is what lets the label coexist with a merge queue: once the
// label triggers the queue, the queue rebases the branch and re-runs CI, which
// reads back as pending/unknown for a spell. Treating that as `hold` (not
// `regressed`) keeps the label on, so the PR is never yanked back out of the
// queue mid-merge. The queue's own gating check is excluded upstream in
// `checksInfo`, so it never keeps CI perpetually pending here.
export type ReadyVerdict = "ready" | "regressed" | "hold";

// Whether the board should show a PR as ready-to-merge for a given verdict. True
// when it is ready, or when it is held but already carries the ready label -- a
// PR queued to merge (labeled, CI re-running under the queue) reads back as
// `hold`, and we want the board to say "ready to merge", not stay stuck on the
// last fix status that touched the row.
export function boardReadyToMerge(verdict: ReadyVerdict, hasLabel: boolean): boolean {
  return verdict === "ready" || (verdict === "hold" && hasLabel);
}

// Reads short-circuit in cheap-first order (an unresolved thread returns before
// the mergeable/CI reads), so a regressed PR costs the fewest gh calls. A read
// rejecting propagates to readyOnce, which skips the PR for this tick.
async function classify(prNumber: number, deps: PrReadyDeps): Promise<ReadyVerdict> {
  if ((await deps.unresolvedInfo(prNumber)).count !== 0) return "regressed";
  // A conflict is a hold, not a regression: the repo's resolve-generated-conflicts
  // sweep discovers PRs by the ready-to-merge/blocked labels, so stripping the
  // label here would hide the PR from the auto-heal (and its approval-preserving
  // App push). Real conflicts get a "needs a human" comment from that sweep, and
  // Aviator relabels to blocked if a queued conflict fails its speculative merge.
  const mergeable = (await deps.mergeableInfo(prNumber)).state;
  if (mergeable === "conflicting") return "hold";
  if (mergeable === "unknown") return "hold";
  const ci = (await deps.checksInfo(prNumber)).state;
  if (ci === "failing") return "regressed";
  if (ci === "pending") return "hold";
  return "ready"; // passing or none
}

// One ready-step tick, run every heartbeat. For each open PR, keep the ready
// label in sync with its readiness: add it when the PR is ready and lacks it,
// remove it on a hard regression when it carries it, and otherwise leave it
// alone. Drafts are classified (so the board can show "draft pr") but never
// labeled: supervised mode opens PRs as drafts and only a human promotes them. Stateless: it reconciles against GitHub's live label state every tick,
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
    let verdict: ReadyVerdict;
    try {
      verdict = await classify(pr.number, deps);
    } catch (err) {
      deps.log(`readiness check failed for PR #${pr.number}: ${err}`);
      continue;
    }

    // Read labels for every verdict (holds included) so the board can reconcile a
    // queued PR off a stale fix status. The label read is the only added cost of a
    // hold; it still writes nothing.
    let labels: string[];
    try {
      labels = await deps.prLabels(pr.number);
    } catch (err) {
      deps.log(`label read failed for PR #${pr.number}: ${err}`);
      continue;
    }
    if (labels.includes(deps.blockedLabel)) continue; // blocked-fix flow owns this PR's labels
    const hasLabel = labels.includes(deps.label);
    deps.onVerdict?.(pr.number, verdict, hasLabel, pr.isDraft);
    // A draft is a human's to promote: it must never carry the ready label (which
    // queues it to merge). Skip the add even when ready, and strip a stale label
    // left from before the PR was converted back to draft.
    if (pr.isDraft) {
      if (hasLabel) {
        try {
          await deps.removeLabel(pr.number, deps.label);
          deps.log(`removed ${deps.label} from draft PR #${pr.number}`);
        } catch (err) {
          deps.log(`remove label failed for PR #${pr.number}: ${err}`);
        }
      }
      continue;
    }
    if (verdict === "hold") continue; // board reconciled above; neither add nor remove the label

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
