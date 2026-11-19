// Checks 2 and 3 of the prod flag-archive policy: the flag key must be absent
// from gemini's origin/main, from the rest of the org, and from every gemini
// commit prod runs. Every failure to read an input fails the check; nothing
// passes on missing data.
import type { GhRunner } from "./gh.ts";

export type GitResult = { code: number; stdout: string };
// Runs git inside the gemini checkout. Resolves on any exit code so callers can
// tell "no match" (1) from a real error.
export type GitRunner = (args: string[]) => Promise<GitResult>;

export type Check = { name: string; pass: boolean; detail: string };
export type FlagArchiveReport = { pass: boolean; checks: Check[]; prodShas: string[]; docMatches: string[] };

const ORG = "MatthewsREIS";
const GEMINI_REPO = `${ORG}/gemini`;
const PIN_FILE_API = "repos/MatthewsREIS/terraform-cluster-app-resources/contents/prod/app-revisions.yaml";
const SEARCH_LIMIT = 100;

const isCommitRef = (v: string) => /^[0-9a-f]{7,40}$/i.test(v);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function parseArgs(argv: string[]): { key: string; geminiDir: string | null } | null {
  let key: string | null = null;
  let geminiDir: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--gemini-dir") {
      geminiDir = argv[++i] ?? null;
      if (!geminiDir) return null;
    } else if (key === null && !a.startsWith("-")) {
      key = a;
    } else {
      return null;
    }
  }
  if (!key || !/^[A-Za-z0-9._-]+$/.test(key)) return null;
  return { key, geminiDir };
}

export function parsePinFile(text: string): { app: string; ref: string }[] {
  const pins: { app: string; ref: string }[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*:\s*"?([^"#\s]+)"?\s*(#.*)?$/);
    if (m && isCommitRef(m[2]!)) pins.push({ app: m[1]!, ref: m[2]! });
  }
  return pins;
}

export function parseAppVersion(chartYaml: string): string | null {
  const m = chartYaml.match(/^appVersion\s*:\s*"?([^"#\s]+)"?/m);
  return m ? m[1]! : null;
}

export function chartPathsOf(lsTree: string): string[] {
  return lsTree.split("\n").filter((p) => p === "Chart.yaml" || p.endsWith("/Chart.yaml"));
}

export function classifyMatches(paths: string[]): { code: string[]; docs: string[] } {
  const isDoc = (p: string) => /\.md$/i.test(p);
  return { code: paths.filter((p) => !isDoc(p)), docs: paths.filter(isDoc) };
}

async function mustGit(git: GitRunner, args: string[]): Promise<string> {
  const r = await git(args);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed (exit ${r.code})`);
  return r.stdout;
}

// Resolve a pin or appVersion to a full SHA, fetching it from origin when it
// is not local yet. A short SHA can't be fetched directly, so the last resort
// is a plain fetch of origin's branches.
async function resolveCommit(git: GitRunner, ref: string): Promise<string> {
  const parse = async () => {
    const r = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  };
  const steps = [["fetch", "origin", ref], ["fetch", "origin"]];
  let sha = await parse();
  for (const step of steps) {
    if (sha) break;
    await git(step);
    sha = await parse();
  }
  if (!sha) throw new Error(`cannot resolve commit ${ref}`);
  return sha;
}

export async function collectProdCommits(gh: GhRunner, git: GitRunner): Promise<string[]> {
  const pinText = await gh(["api", "-H", "Accept: application/vnd.github.raw", PIN_FILE_API]);
  const pins = parsePinFile(pinText);
  if (pins.length === 0) throw new Error("no commit pins found in prod/app-revisions.yaml");
  const resolved = new Set<string>();
  for (const ref of new Set(pins.map((p) => p.ref))) {
    const sha = await resolveCommit(git, ref);
    resolved.add(sha);
    for (const path of chartPathsOf(await mustGit(git, ["ls-tree", "-r", "--name-only", sha]))) {
      const version = parseAppVersion(await mustGit(git, ["show", `${sha}:${path}`]));
      if (version && isCommitRef(version)) resolved.add(await resolveCommit(git, version));
    }
  }
  return [...resolved];
}

async function grepRev(git: GitRunner, rev: string, key: string): Promise<string[]> {
  const r = await git(["grep", "-F", "-l", "-e", key, rev, "--"]);
  if (r.code === 1) return [];
  if (r.code !== 0) throw new Error(`git grep failed at ${rev} (exit ${r.code})`);
  const prefix = `${rev}:`;
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => (l.startsWith(prefix) ? l.slice(prefix.length) : l));
}

type SearchRow = { repository?: { nameWithOwner?: string }; path?: string };

export async function searchOrg(gh: GhRunner, key: string): Promise<{ code: string[]; docs: string[] }> {
  const args = ["search", "code", `"${key}"`, "--owner", ORG, "--json", "repository,path", "--limit", String(SEARCH_LIMIT)];
  let out: string;
  try {
    out = await gh(args);
  } catch {
    out = await gh(args);
  }
  const rows = JSON.parse(out) as SearchRow[];
  if (rows.length >= SEARCH_LIMIT) throw new Error(`too many org search results (${rows.length}), cannot classify`);
  const hits = rows
    .filter((r) => r.repository?.nameWithOwner !== GEMINI_REPO)
    .map((r) => `${r.repository?.nameWithOwner ?? "?"}:${r.path ?? "?"}`);
  return classifyMatches(hits);
}

const summarize = (paths: string[]) => paths.slice(0, 10).join(", ") + (paths.length > 10 ? `, +${paths.length - 10} more` : "");

async function guarded(name: string, run: () => Promise<{ pass: boolean; detail: string }>): Promise<Check> {
  try {
    return { name, ...(await run()) };
  } catch (e) {
    return { name, pass: false, detail: `check could not run: ${errMsg(e)}` };
  }
}

export async function runFlagArchiveCheck(opts: { key: string; gh: GhRunner; git: GitRunner }): Promise<FlagArchiveReport> {
  const { key, gh, git } = opts;
  const docMatches: string[] = [];
  let prodShas: string[] = [];

  const main = await guarded("main-gemini", async () => {
    await mustGit(git, ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
    const { code, docs } = classifyMatches(await grepRev(git, "origin/main", key));
    docMatches.push(...docs.map((d) => `origin/main:${d}`));
    return code.length
      ? { pass: false, detail: `key found on origin/main in: ${summarize(code)}` }
      : { pass: true, detail: "no code references on origin/main" };
  });

  const org = await guarded("org-search", async () => {
    const { code, docs } = await searchOrg(gh, key);
    docMatches.push(...docs);
    return code.length
      ? { pass: false, detail: `key found elsewhere in the org: ${summarize(code)}` }
      : { pass: true, detail: `no code references in ${ORG} outside gemini` };
  });

  const prod = await guarded("prod-commits", async () => {
    prodShas = await collectProdCommits(gh, git);
    const failures: string[] = [];
    for (const sha of prodShas) {
      const { code, docs } = classifyMatches(await grepRev(git, sha, key));
      docMatches.push(...docs.map((d) => `${sha.slice(0, 9)}:${d}`));
      if (code.length) failures.push(`${sha.slice(0, 9)} (${summarize(code)})`);
    }
    return failures.length
      ? { pass: false, detail: `key found at deployed commits: ${failures.join("; ")}` }
      : { pass: true, detail: `no code references at ${prodShas.length} deployed commits` };
  });

  const checks = [main, org, prod];
  return { pass: checks.every((c) => c.pass), checks, prodShas, docMatches: [...new Set(docMatches)] };
}
