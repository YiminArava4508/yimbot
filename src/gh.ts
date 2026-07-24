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
  "pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}";

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
