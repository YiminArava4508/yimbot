import { execFileSync } from "node:child_process";

export type OpenPR = { number: number; headRefName: string; isDraft: boolean };
export type RepoSlug = { owner: string; name: string };

// Injectable `gh` invoker: takes CLI args, returns stdout. The default shells out
// to gh with a fixed cwd so the repo resolves from that checkout's origin, and
// keeps stderr so failures surface a useful message.
export type GhRunner = (args: string[]) => string;

export function ghRunner(cwd: string): GhRunner {
  return (args) => execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function parseOpenPRs(json: string): OpenPR[] {
  const rows = JSON.parse(json) as OpenPR[];
  return rows.map((r) => ({ number: r.number, headRefName: r.headRefName, isDraft: r.isDraft }));
}

// The viewer's open PRs in the runner's repo (drafts included; callers filter).
export function listMyOpenPRs(run: GhRunner): OpenPR[] {
  return parseOpenPRs(
    run(["pr", "list", "--author", "@me", "--state", "open", "--json", "number,headRefName,isDraft", "--limit", "100"]),
  );
}

export type MergedPR = { number: number; headRefName: string };

export function parseMergedPRs(json: string): MergedPR[] {
  const rows = JSON.parse(json) as MergedPR[];
  return rows.map((r) => ({ number: r.number, headRefName: r.headRefName }));
}

// The viewer's merged PRs in the runner's repo. Bounded to the 100 most recent:
// a worktree whose PR merged more than 100 merges ago is not a realistic case.
export function listMyMergedPRs(run: GhRunner): MergedPR[] {
  return parseMergedPRs(
    run(["pr", "list", "--author", "@me", "--state", "merged", "--json", "number,headRefName", "--limit", "100"]),
  );
}

// owner/name of the repo gh resolves in the runner's cwd — needed as GraphQL
// variables for the review-thread query below.
export function repoSlug(run: GhRunner): RepoSlug {
  const data = JSON.parse(run(["repo", "view", "--json", "owner,name"])) as {
    owner: { login: string };
    name: string;
  };
  return { owner: data.owner.login, name: data.name };
}

const THREADS_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){" +
  "repository(owner:$owner,name:$name){" +
  "pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}";

export function parseUnresolvedCount(json: string): number {
  const data = JSON.parse(json) as {
    data: { repository: { pullRequest: { reviewThreads: { nodes: { isResolved: boolean }[] } } } };
  };
  return data.data.repository.pullRequest.reviewThreads.nodes.filter((n) => !n.isResolved).length;
}

// Number of unresolved review threads on a PR, any author (humans + bots). This
// is what decides whether a PR still needs a fix session.
export function unresolvedThreadCount(run: GhRunner, slug: RepoSlug, prNumber: number): number {
  return parseUnresolvedCount(
    run([
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
