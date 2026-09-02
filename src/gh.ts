import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type OpenPR = { number: number; headRefName: string; isDraft: boolean };
export type RepoSlug = { owner: string; name: string };

// Injectable `gh` invoker: takes CLI args, resolves to stdout. The default shells
// out to gh with a fixed cwd so the repo resolves from that checkout's origin.
// Async so the network round-trip never blocks the heartbeat's event loop.
export type GhRunner = (args: string[]) => Promise<string>;

export function ghRunner(cwd: string): GhRunner {
  return async (args) => {
    const { stdout } = await execFileAsync("gh", args, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  };
}

export function parseOpenPRs(json: string): OpenPR[] {
  const rows = JSON.parse(json) as OpenPR[];
  return rows.map((r) => ({ number: r.number, headRefName: r.headRefName, isDraft: r.isDraft }));
}

// The viewer's open PRs in the runner's repo (drafts included; callers filter).
export async function listMyOpenPRs(run: GhRunner): Promise<OpenPR[]> {
  return parseOpenPRs(
    await run(["pr", "list", "--author", "@me", "--state", "open", "--json", "number,headRefName,isDraft", "--limit", "100"]),
  );
}

export type MergedPR = { number: number; headRefName: string };

export function parseMergedPRs(json: string): MergedPR[] {
  const rows = JSON.parse(json) as MergedPR[];
  return rows.map((r) => ({ number: r.number, headRefName: r.headRefName }));
}

// The viewer's merged PRs in the runner's repo. Bounded to the 100 most recent:
// a worktree whose PR merged more than 100 merges ago is not a realistic case.
export async function listMyMergedPRs(run: GhRunner): Promise<MergedPR[]> {
  return parseMergedPRs(
    await run(["pr", "list", "--author", "@me", "--state", "merged", "--json", "number,headRefName", "--limit", "100"]),
  );
}

// A closed PR row: `--state closed` returns merged PRs too, so `mergedAt`
// distinguishes a truly closed-unmerged PR (null) from a merged one (a timestamp).
type ClosedPRRow = { number: number; headRefName: string; mergedAt: string | null };

export function parseClosedUnmergedPRs(json: string): MergedPR[] {
  const rows = JSON.parse(json) as ClosedPRRow[];
  return rows
    .filter((r) => r.mergedAt === null)
    .map((r) => ({ number: r.number, headRefName: r.headRefName }));
}

// The viewer's CLOSED-but-not-merged PRs (spikes, abandoned or superseded work):
// their worktree/session is never caught by the merged-PR reaper. gh's
// `--state closed` also returns merged PRs, hence the mergedAt filter above.
// Bounded to the 100 most recent, matching listMyMergedPRs.
export async function listMyClosedUnmergedPRs(run: GhRunner): Promise<MergedPR[]> {
  return parseClosedUnmergedPRs(
    await run(["pr", "list", "--author", "@me", "--state", "closed", "--json", "number,headRefName,mergedAt", "--limit", "100"]),
  );
}

// owner/name of the repo gh resolves in the runner's cwd — needed as GraphQL
// variables for the review-thread query below.
export async function repoSlug(run: GhRunner): Promise<RepoSlug> {
  const data = JSON.parse(await run(["repo", "view", "--json", "owner,name"])) as {
    owner: { login: string };
    name: string;
  };
  return { owner: data.owner.login, name: data.name };
}

const THREADS_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){" +
  "repository(owner:$owner,name:$name){" +
  "pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved " +
  "comments(last:1){nodes{createdAt author{login}}}}}}}}";

export type UnresolvedInfo = {
  count: number;
  newestOtherCommentAt: number | null;
  newestTrustedCommentAt: number | null;
  newestHumanCommentAt: number | null;
};

function newerOf(cur: number | null, at: number): number {
  return cur === null || at > cur ? at : cur;
}

type ThreadNode = {
  isResolved: boolean;
  comments: { nodes: { createdAt: string; author: { login: string } | null }[] };
};

// Unresolved-thread summary for a PR. `count` is the number of unresolved threads
// (any author). The `newest*At` fields are the newest latest-comment timestamps
// (epoch ms) among unresolved threads whose latest comment is NOT the viewer's,
// or null when there is none: `newestOtherCommentAt` over all such comments,
// split into trusted (login in `trusted`, e.g. Copilot's review bot) and human
// (everyone else). Supervised mode spawns fixes on the trusted split only and
// flags the human split for a person.
export function parseUnresolvedInfo(json: string, viewer: string, trusted: Set<string> = new Set()): UnresolvedInfo {
  const data = JSON.parse(json) as {
    data: { repository: { pullRequest: { reviewThreads: { nodes: ThreadNode[] } } } };
  };
  const unresolved = data.data.repository.pullRequest.reviewThreads.nodes.filter((n) => !n.isResolved);
  let newestOther: number | null = null;
  let newestTrusted: number | null = null;
  let newestHuman: number | null = null;
  for (const t of unresolved) {
    const latest = t.comments.nodes.at(-1);
    if (!latest) continue;
    if (latest.author && latest.author.login === viewer) continue;
    const at = Date.parse(latest.createdAt);
    if (Number.isNaN(at)) continue;
    newestOther = newerOf(newestOther, at);
    if (latest.author && trusted.has(latest.author.login.toLowerCase())) {
      newestTrusted = newerOf(newestTrusted, at);
    } else {
      newestHuman = newerOf(newestHuman, at);
    }
  }
  return {
    count: unresolved.length,
    newestOtherCommentAt: newestOther,
    newestTrustedCommentAt: newestTrusted,
    newestHumanCommentAt: newestHuman,
  };
}

export async function unresolvedThreadInfo(
  run: GhRunner,
  slug: RepoSlug,
  prNumber: number,
  viewer: string,
  trusted: Set<string> = new Set(),
): Promise<UnresolvedInfo> {
  return parseUnresolvedInfo(
    await run([
      "api", "graphql",
      "-f", `query=${THREADS_QUERY}`,
      "-f", `owner=${slug.owner}`,
      "-f", `name=${slug.name}`,
      "-F", `number=${prNumber}`,
    ]),
    viewer,
    trusted,
  );
}

export type CiState = "passing" | "failing" | "pending" | "none";
export type ChecksInfo = { state: CiState; headSha: string };

// CheckRun.conclusion values that mean the check failed. NEUTRAL/SKIPPED/SUCCESS
// are not failures. A null conclusion means the run hasn't finished (pending).
const FAILING_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED"]);

type RollupNode = {
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
  workflowName?: string;
  startedAt?: string;
  completedAt?: string;
};

// GitHub keeps every historical run of a check in the rollup, so a check that was
// cancelled and later reran to green appears twice. Only the latest run per check
// reflects the PR's real state (it's what the GitHub UI shows), so collapse each
// check to its most recent run before classifying. A stale CANCELLED/FAILURE run
// would otherwise flip the whole rollup to failing. CheckRuns are keyed by
// workflow + name and ordered by startedAt (fallback completedAt); StatusContexts
// carry no timestamps but the API already returns one row per context, so they key
// by context and never collide. A freshly queued rerun reports no timestamps at
// all; rank it as newest (not oldest) so it wins over the prior completed run and
// the rollup reads pending, preserving the "pending takes precedence" contract.
function latestPerCheck(nodes: RollupNode[]): RollupNode[] {
  const rank = (n: RollupNode) => n.startedAt ?? n.completedAt ?? "￿";
  const latest = new Map<string, RollupNode>();
  for (const n of nodes) {
    const key =
      n.context !== undefined ? `ctx:${n.context}` : `run:${n.workflowName ?? ""}::${n.name ?? ""}`;
    const prev = latest.get(key);
    if (!prev || rank(n) >= rank(prev)) latest.set(key, n);
  }
  return [...latest.values()];
}

// CI summary for a PR from `gh pr view --json headRefOid,statusCheckRollup`.
// `pending` takes precedence over `failing`: while any check is still running we
// wait rather than act on a half-finished run. A rollup node is a CheckRun
// (status + conclusion) or a StatusContext (state); classify off whichever fields
// are present so a missing __typename never misreads a node. `ignore` drops
// matching checks (by CheckRun name or StatusContext context) before classifying,
// so a merge-queue bot's own gating check — which only completes once the PR is
// queued to merge — never counts as pending and deadlocks the readiness signal.
export function parseChecksInfo(json: string, ignore?: (name: string) => boolean): ChecksInfo {
  const data = JSON.parse(json) as { headRefOid: string; statusCheckRollup: RollupNode[] };
  const all = latestPerCheck(data.statusCheckRollup ?? []);
  const nodes = ignore ? all.filter((n) => !ignore(n.name ?? n.context ?? "")) : all;
  let pending = false;
  let failing = false;
  for (const n of nodes) {
    if ((n.status !== undefined && n.status !== "COMPLETED") || n.state === "PENDING" || n.state === "EXPECTED") {
      pending = true;
    }
    if ((n.conclusion != null && FAILING_CONCLUSIONS.has(n.conclusion)) || n.state === "FAILURE" || n.state === "ERROR") {
      failing = true;
    }
  }
  const state: CiState = nodes.length === 0 ? "none" : pending ? "pending" : failing ? "failing" : "passing";
  return { state, headSha: data.headRefOid };
}

export async function checksInfo(
  run: GhRunner,
  prNumber: number,
  ignore?: (name: string) => boolean,
): Promise<ChecksInfo> {
  return parseChecksInfo(await run(["pr", "view", String(prNumber), "--json", "headRefOid,statusCheckRollup"]), ignore);
}

export type MergeableState = "mergeable" | "conflicting" | "unknown";
export type MergeableInfo = { state: MergeableState; headSha: string };

// Mergeability summary for a PR from `gh pr view --json mergeable,headRefOid`.
// GitHub computes mergeability asynchronously, so a just-pushed PR reads UNKNOWN
// for a moment; only CONFLICTING (actual textual conflicts with the base) is
// actionable — MERGEABLE, UNKNOWN, and an absent field are all "do nothing",
// the same discipline the CI rollup applies to a pending run.
export function parseMergeableInfo(json: string): MergeableInfo {
  const data = JSON.parse(json) as { mergeable?: string; headRefOid: string };
  const state: MergeableState =
    data.mergeable === "CONFLICTING" ? "conflicting" : data.mergeable === "MERGEABLE" ? "mergeable" : "unknown";
  return { state, headSha: data.headRefOid };
}

export async function mergeableInfo(run: GhRunner, prNumber: number): Promise<MergeableInfo> {
  return parseMergeableInfo(await run(["pr", "view", String(prNumber), "--json", "mergeable,headRefOid"]));
}

export type BlockedInfo = { blocked: boolean; headSha: string };

// Whether a PR carries the merge-queue's "blocked" label, from
// `gh pr view <n> --json labels,headRefOid`. The queue (Aviator) adds the label
// when its combined-CI batch fails, so it is the trigger for the blocked-fix step.
// The match is exact on the configured name; `headSha` (from headRefOid) keys the
// per-head re-trigger dedup, the same discipline the CI and conflict steps use.
export function parseBlockedInfo(json: string, label: string): BlockedInfo {
  const data = JSON.parse(json) as { labels?: { name: string }[]; headRefOid: string };
  const blocked = (data.labels ?? []).some((l) => l.name === label);
  return { blocked, headSha: data.headRefOid };
}

export async function blockedInfo(run: GhRunner, prNumber: number, label: string): Promise<BlockedInfo> {
  return parseBlockedInfo(await run(["pr", "view", String(prNumber), "--json", "labels,headRefOid"]), label);
}

export type HumanChangesRequested = { requested: boolean; latestAt: number | null };

// Author-aware changes-requested from `gh pr view <n> --json latestReviews`
// (GitHub's latest review per author). Only a review by an author outside
// `trusted` counts as a human block; `latestAt` is the newest such review's
// submittedAt (epoch ms), which supervised mode compares against the last
// unflag to re-raise only on a re-submitted review.
export function parseHumanChangesRequested(json: string, trusted: Set<string>): HumanChangesRequested {
  const data = JSON.parse(json) as {
    latestReviews?: { author?: { login: string } | null; state?: string; submittedAt?: string }[];
  };
  let requested = false;
  let latestAt: number | null = null;
  for (const r of data.latestReviews ?? []) {
    if (r.state !== "CHANGES_REQUESTED") continue;
    if (r.author && trusted.has(r.author.login.toLowerCase())) continue;
    requested = true;
    const at = Date.parse(r.submittedAt ?? "");
    if (!Number.isNaN(at)) latestAt = newerOf(latestAt, at);
  }
  return { requested, latestAt };
}

export async function humanChangesRequested(
  run: GhRunner,
  prNumber: number,
  trusted: Set<string>,
): Promise<HumanChangesRequested> {
  return parseHumanChangesRequested(await run(["pr", "view", String(prNumber), "--json", "latestReviews"]), trusted);
}

// The label names currently on a PR from `gh pr view <n> --json labels`.
export function parseLabels(json: string): string[] {
  const data = JSON.parse(json) as { labels?: { name: string }[] };
  return (data.labels ?? []).map((l) => l.name);
}

export async function prLabels(run: GhRunner, prNumber: number): Promise<string[]> {
  return parseLabels(await run(["pr", "view", String(prNumber), "--json", "labels"]));
}

export type PrState = { labels: string[]; isDraft: boolean };

// Labels and the draft flag together, from one `gh pr view`. The ready step
// needs both live: the open-PR listing it walks is a snapshot taken at tick
// start, and an operator queueing a PR mid-tick promotes it out of draft.
export function parsePrState(json: string): PrState {
  return { labels: parseLabels(json), isDraft: parseIsDraft(json) };
}

export async function prState(run: GhRunner, prNumber: number): Promise<PrState> {
  return parsePrState(await run(["pr", "view", String(prNumber), "--json", "labels,isDraft"]));
}

// Add / remove a single label on a PR. The gh stdout is discarded; a non-zero
// exit rejects (e.g. --add-label with a label that doesn't exist in the repo),
// which the caller catches and logs.
export async function addLabel(run: GhRunner, prNumber: number, label: string): Promise<void> {
  await run(["pr", "edit", String(prNumber), "--add-label", label]);
}

export async function removeLabel(run: GhRunner, prNumber: number, label: string): Promise<void> {
  await run(["pr", "edit", String(prNumber), "--remove-label", label]);
}

// The label names from `gh label list --json name` (an array of {name} rows,
// unlike the pr view shape parseLabels handles).
export function parseLabelNames(json: string): string[] {
  return (JSON.parse(json) as { name: string }[]).map((l) => l.name);
}

// Whether the repo defines the label. --search fuzzy-matches, so the parsed
// names are exact-matched here.
export async function repoLabelExists(run: GhRunner, label: string): Promise<boolean> {
  const names = parseLabelNames(await run(["label", "list", "--search", label, "--json", "name", "--limit", "100"]));
  return names.includes(label);
}

export function parseIsDraft(json: string): boolean {
  return (JSON.parse(json) as { isDraft: boolean }).isDraft;
}

export async function prIsDraft(run: GhRunner, prNumber: number): Promise<boolean> {
  return parseIsDraft(await run(["pr", "view", String(prNumber), "--json", "isDraft"]));
}

// Promote a draft PR to ready-for-review.
export async function markPrReadyForReview(run: GhRunner, prNumber: number): Promise<void> {
  await run(["pr", "ready", String(prNumber)]);
}

// The TUI's r keypress: put the ready label on a PR, promoting a draft first
// (labeling a draft would queue a PR the merge queue cannot take). Rejects
// before any mutation when the repo lacks the label, with a message the status
// bar can show verbatim; gh's own --add-label failure text names the flag, not
// the fix.
export async function applyReadyLabel(run: GhRunner, prNumber: number, label: string): Promise<void> {
  if (!(await repoLabelExists(run, label))) {
    throw new Error(`label '${label}' does not exist in the repo`);
  }
  if (await prIsDraft(run, prNumber)) await markPrReadyForReview(run, prNumber);
  await addLabel(run, prNumber, label);
}

export function parseViewerLogin(json: string): string {
  return (JSON.parse(json) as { data: { viewer: { login: string } } }).data.viewer.login;
}

// The authenticated gh user's login -- used to exclude the daemon's own comments
// from the re-trigger recency signal.
export async function viewerLogin(run: GhRunner): Promise<string> {
  return parseViewerLogin(await run(["api", "graphql", "-f", "query=query{viewer{login}}"]));
}

// The PR's raw unified diff, for the review view. Returned verbatim;
// src/review-diff.ts owns the parsing.
export async function prDiff(run: GhRunner, prNumber: number): Promise<string> {
  return run(["pr", "diff", String(prNumber)]);
}

export type PrReviewMeta = {
  title: string;
  body: string;
  headSha: string;
  additions: number;
  deletions: number;
};

// The slice the review-order prompt needs per PR; served by the same pr view.
export type PrOrderMeta = Pick<PrReviewMeta, "title" | "body" | "additions" | "deletions">;

export function parsePrReviewMeta(json: string): PrReviewMeta {
  const d = JSON.parse(json) as {
    title: string;
    body?: string;
    headRefOid: string;
    additions: number;
    deletions: number;
  };
  return {
    title: d.title,
    body: d.body ?? "",
    headSha: d.headRefOid,
    additions: d.additions,
    deletions: d.deletions,
  };
}

// One pr view for everything the review overlay and the review-order prompt
// need: title/body feed the grouping and ordering prompts, headSha keys viewed
// marks, the diffstat feeds the ordering.
export async function prReviewMeta(run: GhRunner, prNumber: number): Promise<PrReviewMeta> {
  return parsePrReviewMeta(
    await run(["pr", "view", String(prNumber), "--json", "title,body,headRefOid,additions,deletions"]),
  );
}
