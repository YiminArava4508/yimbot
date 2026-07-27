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

export function parseUnresolvedCount(json: string): number {
  const data = JSON.parse(json) as {
    data: { repository: { pullRequest: { reviewThreads: { nodes: { isResolved: boolean }[] } } } };
  };
  return data.data.repository.pullRequest.reviewThreads.nodes.filter((n) => !n.isResolved).length;
}

// Number of unresolved review threads on a PR, any author (humans + bots). This
// is what decides whether a PR still needs a fix session.
export async function unresolvedThreadCount(run: GhRunner, slug: RepoSlug, prNumber: number): Promise<number> {
  return parseUnresolvedCount(
    await run([
      "api",
      "graphql",
      "-f",
      `query=${THREADS_QUERY}`,
      "-f",
      `owner=${slug.owner}`,
      "-f",
      `name=${slug.name}`,
      "-F",
      `number=${prNumber}`,
    ]),
  );
}

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

export function parseViewerLogin(json: string): string {
  return (JSON.parse(json) as { data: { viewer: { login: string } } }).data.viewer.login;
}

// The authenticated gh user's login -- used to exclude the daemon's own comments
// from the re-trigger recency signal.
export async function viewerLogin(run: GhRunner): Promise<string> {
  return parseViewerLogin(await run(["api", "graphql", "-f", "query=query{viewer{login}}"]));
}
