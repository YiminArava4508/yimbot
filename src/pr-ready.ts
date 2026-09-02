import type { Section } from "./events.ts";
import type { ChecksInfo, MergeableInfo, OpenPR, PrState, UnresolvedInfo } from "./gh.ts";
import type { Mode } from "./mode.ts";

export type PrReadyDeps = {
  // The viewer's open PRs, drafts included.
  listOpenPRs: () => Promise<OpenPR[]>;
  // Unresolved-thread summary for a PR: count + newest other-authored comment ms.
  unresolvedInfo: (prNumber: number) => Promise<UnresolvedInfo>;
  // Mergeability summary for a PR: conflicting/mergeable/unknown + head SHA.
  mergeableInfo: (prNumber: number) => Promise<MergeableInfo>;
  // CI summary for a PR: rollup state + head SHA.
  checksInfo: (prNumber: number) => Promise<ChecksInfo>;
  // A PR's labels and draft flag, read together and live. Both have to be
  // fresh: listOpenPRs is a snapshot taken at tick start, and an operator
  // queueing a PR mid-tick promotes it out of draft and labels it, which the
  // snapshot's isDraft would then contradict for a whole heartbeat.
  prState: (prNumber: number) => Promise<PrState>;
  // Add the ready label to a PR. The ready step never removes the label: once
  // on (by the bot or a human), only a human or the merge queue takes it off.
  addLabel: (prNumber: number, label: string) => Promise<void>;
  // The label name to add when a PR is ready (e.g. "ready-to-merge").
  label: string;
  // The merge-queue "blocked" label. A PR carrying it is owned by the blocked-fix
  // flow, so the ready step leaves its labels untouched (never re-queues it).
  blockedLabel: string;
  // How long a PR's ready verdict must hold, uninterrupted, before the label
  // goes on. A PR that just went green is often about to change again (late
  // review comment, rebase, sibling merge), so readiness has to soak first.
  soakMs: number;
  // Clock, injectable for tests.
  now: () => number;
  // The bot's operating mode, read fresh each tick. Supervised leaves the label
  // entirely alone (a human owns it); autonomous only ever adds it. Verdicts are
  // reported in both modes so the board stays live.
  mode: () => Mode;
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
  // Report which board pane a PR belongs in, for every open PR including the
  // blocked ones onVerdict skips: reporting a section is a read, and a blocked
  // PR has lost the ready label, so the board must move it out of the merge
  // pane. Derived from labels and the draft flag alone, so it still fires when
  // the readiness reads fail.
  onSection?: (prNumber: number, section: Section) => void;
  log: (msg: string) => void;
};

// Three outcomes. Only `ready` can trigger a label write (an add, in autonomous
// mode); the other two exist for the board:
//   ready     - every thread resolved, mergeable, CI green (or none).
//   regressed - a hard failure (unresolved thread or failing CI). The label
//               stays put regardless: the ready step never removes it, so a
//               labeled PR that regresses keeps its queue slot while the fixers
//               work, and a human-applied label is never second-guessed.
//   hold      - neither: a still-running CI check, GitHub's not-yet-computed
//               mergeable state, or a merge conflict (the label-driven conflict
//               sweep heals those). No add: readiness is not yet proven.
export type ReadyVerdict = "ready" | "regressed" | "hold";

// `latched`: PR numbers that have carried the ready label at least once this
// daemon run, whether the bot added it or it was observed already on (e.g.
// human-applied). A latched PR is never labeled again: a removal by a human or
// the merge queue is final, not fought every heartbeat. In-memory, so after a
// restart a PR whose label was removed pre-restart could be labeled once more;
// the latch then re-arms from the live labels on the first tick.
// `readySince`: when each PR's current uninterrupted run of ready verdicts
// began, for the soak. Cleared the moment a verdict is anything but ready, so
// a regression mid-soak restarts the clock. Also in-memory: a restart restarts
// every soak, which only delays a label, never adds one early.
export type ReadyState = { latched: Set<number>; readySince: Map<number, number> };

export function freshReadyState(): ReadyState {
  return { latched: new Set(), readySince: new Map() };
}

// Whether the board should show a PR as ready-to-merge for a given verdict. True
// when it is ready, or when it is held but already carries the ready label -- a
// PR queued to merge (labeled, CI re-running under the queue) reads back as
// `hold`, and we want the board to say "ready to merge", not stay stuck on the
// last fix status that touched the row.
export function boardReadyToMerge(verdict: ReadyVerdict, hasLabel: boolean): boolean {
  return verdict === "ready" || (verdict === "hold" && hasLabel);
}

// Which pane a PR's row belongs in. Deliberately not derived from the verdict:
// placement has to be sticky so a queued PR stays in the merge pane while its
// status walks through a CI fix or a review round, and the ready label is the
// only fact that says "queued". A draft outranks the label because a draft
// cannot merge whatever its labels say.
export function boardSection(isDraft: boolean, hasLabel: boolean): Section {
  if (isDraft) return "review";
  return hasLabel ? "merge" : "tasks";
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

// One ready-step tick, run every heartbeat. The label write is add-only and
// autonomous-only: in autonomous mode a ready PR that lacks the label gets it;
// nothing here ever removes the label, and supervised mode writes nothing at all
// (the label is a human's to manage there). Every PR is still classified in both
// modes so the board reflects readiness. Drafts are classified (so the board can
// show "draft pr") but never labeled: supervised mode opens PRs as drafts and
// only a human promotes them. Each add happens at most once per PR: the latch
// in `state` records every PR seen with the label (however it got it), and a
// latched PR is never re-labeled, so a human or the merge queue taking the
// label off is final.
//
// Adds are also soaked and serialized. Soaked: a PR labels only after its ready
// verdict has held for soakMs straight (the clock resets on any lapse). Serialized:
// while any open PR carries the ready or blocked label the step adds nothing --
// one PR in the queue at a time keeps bot-queued PRs from ever batching against
// each other -- and at most one PR labels per tick. Humans can still queue more
// by hand; the bot then waits for the queue to drain.
//
// A readiness read that errors skips the PR for this tick; an addLabel that
// errors is logged, left unlatched, and the next candidate is tried (a failed
// add queued nothing, so the slot is still free).
export async function readyOnce(state: ReadyState, deps: PrReadyDeps): Promise<void> {
  let prs: OpenPR[];
  try {
    prs = await deps.listOpenPRs();
  } catch (err) {
    deps.log(`pr list failed: ${err}`);
    return;
  }

  // Drop soak clocks for PRs no longer open, so merged/closed PRs do not
  // accumulate in the map forever.
  const open = new Set(prs.map((p) => p.number));
  for (const n of state.readySince.keys()) if (!open.has(n)) state.readySince.delete(n);

  let queueOccupied = false;
  const candidates: number[] = [];
  for (const pr of prs) {
    // Labels come first because the board's section depends on them and nothing
    // else: a PR whose readiness reads fail still has to be placed. Reading them
    // for every PR (holds included) also lets the board reconcile a queued PR off
    // a stale fix status. Still a read; nothing here writes.
    let live: PrState;
    try {
      live = await deps.prState(pr.number);
    } catch (err) {
      deps.log(`label read failed for PR #${pr.number}: ${err}`);
      continue;
    }
    const hasLabel = live.labels.includes(deps.label);
    const isBlocked = live.labels.includes(deps.blockedLabel);
    if (hasLabel) state.latched.add(pr.number); // latch in every mode, blocked PRs included
    if (hasLabel || isBlocked) queueOccupied = true; // queued now, or blocked and due a re-queue
    deps.onSection?.(pr.number, boardSection(live.isDraft, hasLabel));

    let verdict: ReadyVerdict;
    try {
      verdict = await classify(pr.number, deps);
    } catch (err) {
      deps.log(`readiness check failed for PR #${pr.number}: ${err}`);
      continue;
    }

    // The soak clock runs in every mode (so a long-ready PR labels promptly after
    // a switch to autonomous) and resets whenever readiness lapses.
    if (verdict === "ready") {
      if (!state.readySince.has(pr.number)) state.readySince.set(pr.number, deps.now());
    } else {
      state.readySince.delete(pr.number);
    }
    if (isBlocked) continue; // blocked-fix flow owns this PR's labels
    deps.onVerdict?.(pr.number, verdict, hasLabel, live.isDraft);
    if (deps.mode() === "supervised") continue; // the label is a human's to manage
    // A draft is a human's to promote: never add the label (which queues it to
    // merge). A stale label on a draft is likewise left for a human to clear.
    if (live.isDraft) continue;
    if (verdict !== "ready" || state.latched.has(pr.number)) continue;
    const soaked = deps.now() - (state.readySince.get(pr.number) ?? deps.now()) >= deps.soakMs;
    if (soaked) candidates.push(pr.number);
  }

  if (queueOccupied) return; // one PR in the queue at a time
  for (const n of candidates) {
    try {
      await deps.addLabel(n, deps.label);
      state.latched.add(n);
      deps.log(`labeled PR #${n} ${deps.label} (ready to merge)`);
      return; // at most one add per tick
    } catch (err) {
      deps.log(`add label failed for PR #${n}: ${err}`);
    }
  }
}
