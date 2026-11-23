import type { EventKind, Section } from "./events.ts";
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
  // A PR's labels, draft flag and approval, read together and live. Both have to be
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
  // How many labeled-and-approved (or blocked) PRs the bot lets sit in the merge
  // queue at once. Only those are batched by the queue, so only they take a slot.
  maxQueued: number;
  // Optional cap on open PRs that carry the ready label but are not approved yet
  // (each one is a standing review request). Undefined means no cap.
  maxAwaitingReview?: number;
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
  // draft waits for a human to mark it ready for review. Carries `reason` for a
  // regressed verdict (which hard failure tripped it) so the board can name the
  // failure on a row that still claims readiness, instead of leaving "ready to
  // merge" standing while a fixer that is already live works the PR.
  onVerdict?: (
    prNumber: number,
    verdict: ReadyVerdict,
    hasLabel: boolean,
    isDraft: boolean,
    reason: RegressReason | undefined,
    manual: boolean,
    approved: boolean,
    changesRequested: boolean,
  ) => void;
  // Whether the PR's repo has no merge queue, so a ready PR waits on a human
  // to merge it whatever its labels say. Absent means every repo is queued.
  mergesManually?: (prNumber: number) => Promise<boolean>;
  // Report which board pane a PR belongs in, for every open PR including the
  // blocked ones onVerdict skips: reporting a section is a read, and a blocked
  // PR has lost the ready label, so the board must move it out of the merge
  // pane. Derived from labels and the draft flag alone, so it still fires when
  // the readiness reads fail.
  onSection?: (prNumber: number, section: Section) => void;
  // Report a PR the merge queue kicked out (it carries the blocked label). The
  // ready step reports no verdict for such a PR, and the blocked fixer only
  // writes a status when it spawns (deduped per head), so without this the row
  // would keep saying "ready to merge" for as long as the label stays on.
  onBlocked?: (prNumber: number) => void;
  // Overlap gate: given the PRs about to be labeled, says for each whether it may
  // queue (null) or which older PR it must wait on. Absent means no gate.
  queueGate?: (candidates: { n: number; headSha?: string }[]) => Promise<Map<number, number | null>>;
  // Report a PR held back by the gate, so the board can say what it waits on.
  onHeld?: (prNumber: number, holder: number) => void;
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
// Which hard failure produced a regressed verdict.
export type RegressReason = "threads" | "ci";
type Classified = { verdict: ReadyVerdict; reason?: RegressReason; headSha?: string };

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

// Undefined on a failed read: guessing either way would put a wrong ready
// status on the row, so the caller skips the PR and the next tick reads again.
async function mergesManually(prNumber: number, deps: PrReadyDeps): Promise<boolean | undefined> {
  if (!deps.mergesManually) return false;
  try {
    return await deps.mergesManually(prNumber);
  } catch (err) {
    deps.log(`merge queue read failed for PR #${prNumber}: ${err}`);
    return undefined;
  }
}

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

// The status a PR that passed boardReadyToMerge should show. A draft cannot
// merge whatever its labels say. An unlabeled ready PR in supervised mode is
// waiting on a human to queue it, so the row says so instead of reading like a
// queued one; autonomous labels it itself after the soak, so no prompt there.
// A labeled but unapproved PR sits outside the merge queue, which only takes
// approved PRs, so the row names the missing approval, or the outstanding
// changes-requested review when that is what blocks it.
export function boardReadyKind(
  isDraft: boolean,
  hasLabel: boolean,
  mode: Mode,
  manual = false,
  approved = true,
  changesRequested = false,
): EventKind {
  if (isDraft) return "draft_pr";
  if (manual) return "ready_manual";
  if (hasLabel && changesRequested) return "changes_requested";
  if (hasLabel && !approved) return "needs_approval";
  if (!hasLabel && mode === "supervised") return "ready_unqueued";
  return "ready_to_merge";
}

// Which pane a PR's row belongs in. Deliberately not derived from the verdict:
// placement has to be sticky so a queued PR stays in the merge pane while its
// status walks through a CI fix or a review round, and the ready label is the
// only fact that says "queued". A draft outranks the label because a draft
// cannot merge whatever its labels say. An open PR with no label shares the
// review pane with the drafts in both modes. A blocked PR has left the merge
// queue and is yimbot's to fix, so it stays in tasks.
export function boardSection(isDraft: boolean, hasLabel: boolean, isBlocked: boolean): Section {
  if (isDraft) return "review";
  if (hasLabel) return "merge";
  return isBlocked ? "tasks" : "review";
}

// Reads short-circuit in cheap-first order (an unresolved thread returns before
// the mergeable/CI reads), so a regressed PR costs the fewest gh calls. A read
// rejecting propagates to readyOnce, which skips the PR for this tick.
async function classify(prNumber: number, deps: PrReadyDeps): Promise<Classified> {
  if ((await deps.unresolvedInfo(prNumber)).count !== 0) return { verdict: "regressed", reason: "threads" };
  // A conflict is a hold, not a regression: the repo's resolve-generated-conflicts
  // sweep discovers PRs by the ready-to-merge/blocked labels, so stripping the
  // label here would hide the PR from the auto-heal (and its approval-preserving
  // App push). Real conflicts get a "needs a human" comment from that sweep, and
  // Aviator relabels to blocked if a queued conflict fails its speculative merge.
  const mergeInfo = await deps.mergeableInfo(prNumber);
  const mergeable = mergeInfo.state;
  if (mergeable === "conflicting") return { verdict: "hold" };
  if (mergeable === "unknown") return { verdict: "hold" };
  const ci = (await deps.checksInfo(prNumber)).state;
  if (ci === "failing") return { verdict: "regressed", reason: "ci" };
  if (ci === "pending") return { verdict: "hold" };
  return { verdict: "ready", headSha: mergeInfo.headSha }; // passing or none
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
// Adds are soaked, then every eligible candidate is labeled in one tick. Soaked:
// a PR labels only after its ready verdict has held for soakMs straight (the
// clock resets on any lapse). The label also pings reviewers, so it goes on
// before approval. The merge queue only batches PRs that are labeled AND
// approved, so only those (plus blocked PRs, due a re-queue) take one of the
// maxQueued slots. An unapproved candidate is labeled whatever the slot count; an
// approved unlabeled one (approved before the bot got to it) needs a free slot.
// maxAwaitingReview, when set, caps how many labeled-but-unapproved PRs may be
// outstanding. Candidates go oldest-ready first. Manual-merge repos never take a
// slot or count toward the cap.
//
// A readiness read that errors skips the PR for this tick; an addLabel that
// errors is logged, left unlatched, and the loop moves on (a failed add queued
// nothing, so it uses up neither a slot nor cap room).
// Only candidates that could take a slot are gated, so a PR waiting on slot
// room is not shown as waiting on an overlap. Failing open (no gate, gate error).
async function gateCandidates(
  candidates: { n: number; headSha?: string }[],
  deps: PrReadyDeps,
): Promise<Map<number, number | null>> {
  if (!deps.queueGate || candidates.length === 0) return new Map();
  try {
    return await deps.queueGate(candidates);
  } catch (err) {
    deps.log(`overlap gate failed, queueing without it: ${err}`);
    return new Map();
  }
}

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

  let occupied = 0;
  let awaitingReview = 0;
  const candidates: { n: number; approved: boolean; headSha?: string }[] = [];
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
    // A PR in a repo with no merge queue waits on a human whatever its labels
    // say: its label queues nothing, so it never holds the slot or gets one.
    // Undefined when the read failed; the PR then sits this tick out below.
    const manual = await mergesManually(pr.number, deps);
    if (hasLabel) state.latched.add(pr.number); // latch in every mode, blocked PRs included
    if (manual === false) {
      if (isBlocked || (hasLabel && live.approved)) occupied++; // batched now, or blocked and due a re-queue
      else if (hasLabel) awaitingReview++;
    }
    deps.onSection?.(pr.number, boardSection(live.isDraft, hasLabel, isBlocked));

    let verdict: ReadyVerdict;
    let reason: RegressReason | undefined;
    let headSha: string | undefined;
    try {
      ({ verdict, reason, headSha } = await classify(pr.number, deps));
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
    if (isBlocked) {
      deps.onBlocked?.(pr.number);
      continue; // blocked-fix flow owns this PR's labels
    }
    if (manual === undefined) continue;
    deps.onVerdict?.(pr.number, verdict, hasLabel, live.isDraft, reason, manual, live.approved, live.changesRequested);
    if (deps.mode() === "supervised") continue; // the label is a human's to manage
    if (manual) continue;
    // A draft is a human's to promote: never add the label (which queues it to
    // merge). A stale label on a draft is likewise left for a human to clear.
    if (live.isDraft) continue;
    if (verdict !== "ready" || state.latched.has(pr.number)) continue;
    const soaked = deps.now() - (state.readySince.get(pr.number) ?? deps.now()) >= deps.soakMs;
    if (soaked) candidates.push({ n: pr.number, approved: live.approved, headSha });
  }

  const sinceOf = (n: number) => state.readySince.get(n) ?? 0;
  candidates.sort((x, y) => sinceOf(x.n) - sinceOf(y.n));
  let freeSlots = deps.maxQueued - occupied;
  const reviewRoom = () => (deps.maxAwaitingReview === undefined ? Infinity : deps.maxAwaitingReview - awaitingReview);
  const held = await gateCandidates(candidates, deps);
  for (const { n, approved } of candidates) {
    const holder = held.get(n);
    if (holder !== undefined && holder !== null) {
      deps.onHeld?.(n, holder);
      continue;
    }
    if (approved ? freeSlots <= 0 : reviewRoom() <= 0) continue;
    try {
      await deps.addLabel(n, deps.label);
      state.latched.add(n);
      // The section above was read before this label went on; report the new
      // one now so the row does not wait a heartbeat to reach the merge pane.
      deps.onSection?.(n, boardSection(false, true, false));
      if (approved) freeSlots--;
      else awaitingReview++;
      deps.log(`labeled PR #${n} ${deps.label} (ready to merge)`);
    } catch (err) {
      deps.log(`add label failed for PR #${n}: ${err}`);
    }
  }
}
