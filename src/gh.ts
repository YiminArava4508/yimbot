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
    const { stdout } = await execFileAsync("gh", args, { cwd, encoding: "utf8" });
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

export type UnresolvedInfo = { count: number; newestOtherCommentAt: number | null };

type ThreadNode = {
  isResolved: boolean;
  comments: { nodes: { createdAt: string; author: { login: string } | null }[] };
};

// Unresolved-thread summary for a PR. `count` is the number of unresolved threads
// (any author). `newestOtherCommentAt` is the newest latest-comment timestamp
// (epoch ms) among unresolved threads whose latest comment is NOT the viewer's,
// or null if every unresolved thread's latest comment is the viewer's own (we've
// replied and are waiting on a human). This is what decides "is there new work?".
export function parseUnresolvedInfo(json: string, viewer: string): UnresolvedInfo {
  const data = JSON.parse(json) as {
    data: { repository: { pullRequest: { reviewThreads: { nodes: ThreadNode[] } } } };
  };
  const unresolved = data.data.repository.pullRequest.reviewThreads.nodes.filter((n) => !n.isResolved);
  let newest: number | null = null;
  for (const t of unresolved) {
    const latest = t.comments.nodes.at(-1);
    if (!latest) continue;
    if (latest.author && latest.author.login === viewer) continue;
    const at = Date.parse(latest.createdAt);
    if (Number.isNaN(at)) continue;
    if (newest === null || at > newest) newest = at;
  }
  return { count: unresolved.length, newestOtherCommentAt: newest };
}

export async function unresolvedThreadInfo(
  run: GhRunner,
  slug: RepoSlug,
  prNumber: number,
  viewer: string,
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
  );
}

export type CiState = "passing" | "failing" | "pending" | "none";
export type ChecksInfo = { state: CiState; headSha: string };

// CheckRun.conclusion values that mean the check failed. NEUTRAL/SKIPPED/SUCCESS
// are not failures. A null conclusion means the run hasn't finished (pending).
const FAILING_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED"]);

type RollupNode = { name?: string; context?: string; status?: string; conclusion?: string | null; state?: string };

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
  const all = data.statusCheckRollup ?? [];
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

// The label names currently on a PR from `gh pr view <n> --json labels`.
export function parseLabels(json: string): string[] {
  const data = JSON.parse(json) as { labels?: { name: string }[] };
  return (data.labels ?? []).map((l) => l.name);
}

export async function prLabels(run: GhRunner, prNumber: number): Promise<string[]> {
  return parseLabels(await run(["pr", "view", String(prNumber), "--json", "labels"]));
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

export function parseViewerLogin(json: string): string {
  return (JSON.parse(json) as { data: { viewer: { login: string } } }).data.viewer.login;
}

// The authenticated gh user's login -- used to exclude the daemon's own comments
// from the re-trigger recency signal.
export async function viewerLogin(run: GhRunner): Promise<string> {
  return parseViewerLogin(await run(["api", "graphql", "-f", "query=query{viewer{login}}"]));
}
