// Checks 2 and 3 of the prod flag-archive policy: the flag key must be absent
// from gemini's origin/main, from the rest of the org, and from the source
// folder of every gemini build prod runs. Every failure to read an input fails
// the check; nothing passes on missing data.
import { posix } from "node:path";
import type { GhRunner } from "./gh.ts";

export type GitResult = { code: number; stdout: string };
// Runs git inside the gemini checkout. Resolves on any exit code so callers can
// tell "no match" (1) from a real error.
export type GitRunner = (args: string[]) => Promise<GitResult>;

export type Check = { name: string; pass: boolean; detail: string };
// One running build: `chart` at `commit` ships the source under `folder`.
export type ProdBuild = { app: string; chart: string; commit: string; folder: string };
export type FlagArchiveReport = { pass: boolean; checks: Check[]; builds: ProdBuild[]; prodShas: string[]; docMatches: string[] };
export type AppChart = { app: string; path: string | null; repoUrl: string | null };

const ORG = "MatthewsREIS";
const GEMINI_REPO = `${ORG}/gemini`;
const TF_REPO_API = "repos/MatthewsREIS/terraform-cluster-app-resources/contents/prod";
const PIN_FILE_API = `${TF_REPO_API}/app-revisions.yaml`;
const APPS_FILE_API = `${TF_REPO_API}/application-services.tf`;
const SEARCH_LIMIT = 100;

export const DEFAULT_QUIET_HOURS = 4;

export function resolveQuietHours(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_QUIET_HOURS;
}

// Check 4. A null or missing `last_called_at` means the flag was never called,
// which passes. A flag that could not be read at all (PostHog error, no flag
// found) is not this case: the caller fails the check before getting here.
export function checkQuiet(opts: { lastCalledAt: string | null | undefined; now: Date; quietHours: number }): { pass: boolean; detail: string } {
  const { lastCalledAt, now, quietHours } = opts;
  if (lastCalledAt === null || lastCalledAt === undefined) return { pass: true, detail: "never called" };
  const at = new Date(lastCalledAt).getTime();
  if (Number.isNaN(at)) return { pass: false, detail: `last_called_at is not a timestamp: ${lastCalledAt}` };
  const hours = (now.getTime() - at) / 3600_000;
  const ago = `last called ${hours.toFixed(1)}h ago, quiet window is ${quietHours}h`;
  return { pass: hours > quietHours, detail: ago };
}

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

// Reads one `{ ... }` block starting at the opening brace. `top` keeps only the
// text outside nested braces and brackets, so `path = ` inside a nested map is
// not mistaken for the entry's own.
function scanBlock(text: string, open: number): { top: string; end: number } {
  let depth = 0;
  let top = "";
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (depth === 1) top += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "#" || (c === "/" && text[i + 1] === "/")) {
      while (i < text.length && text[i] !== "\n") i++;
      if (depth === 1) top += "\n";
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return { top, end: i };
    }
    if (depth === 1 && c !== "{") top += c;
  }
  throw new Error("unbalanced braces in prod/application-services.tf");
}

export function parseAppCharts(tf: string): AppChart[] {
  const m = /application_services_apps\s*=\s*\{/.exec(tf);
  if (!m) throw new Error("application_services_apps not found in prod/application-services.tf");
  const mapOpen = m.index + m[0].length - 1;
  const apps: AppChart[] = [];
  let i = mapOpen + 1;
  const mapEnd = scanBlock(tf, mapOpen).end;
  const entry = /"([A-Za-z0-9_.-]+)"\s*=\s*\{/y;
  while (i < mapEnd) {
    entry.lastIndex = i;
    const e = entry.exec(tf);
    if (!e) {
      i++;
      continue;
    }
    const open = e.index + e[0].length - 1;
    const { top, end } = scanBlock(tf, open);
    apps.push({
      app: e[1]!,
      path: top.match(/\bpath\s*=\s*"([^"]+)"/)?.[1] ?? null,
      repoUrl: top.match(/\brepo_url\s*=\s*"([^"]+)"/)?.[1] ?? null,
    });
    i = end + 1;
  }
  return apps;
}

export function parseLocalDeps(chartYaml: string, chartDir: string): string[] {
  const deps: string[] = [];
  for (const m of chartYaml.matchAll(/^\s*repository\s*:\s*"?file:\/\/([^"#\s]+)"?/gm)) {
    deps.push(posix.normalize(posix.join(chartDir, m[1]!)));
  }
  return deps;
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

const pointsAtGemini = (a: AppChart) => a.path !== null && (a.repoUrl === null || a.repoUrl.includes(GEMINI_REPO));

// Resolves what each gemini-backed prod app runs: the app's chart at its pinned
// commit names a build (appVersion), and so does every local subchart it pulls
// in. Versions that aren't commits (semver, HEAD, main) are skipped; main is
// covered by check 2.
export async function collectProdBuilds(gh: GhRunner, git: GitRunner): Promise<ProdBuild[]> {
  const pins = parsePinFile(await gh(["api", "-H", "Accept: application/vnd.github.raw", PIN_FILE_API]));
  if (pins.length === 0) throw new Error("no commit pins found in prod/app-revisions.yaml");
  const charts = parseAppCharts(await gh(["api", "-H", "Accept: application/vnd.github.raw", APPS_FILE_API]));
  const builds: ProdBuild[] = [];
  for (const pin of pins) {
    const def = charts.find((c) => c.app === pin.app);
    if (!def) throw new Error(`${pin.app} is pinned but missing from prod/application-services.tf`);
    if (!pointsAtGemini(def)) continue;
    const pinSha = await resolveCommit(git, pin.ref);
    const queue = [def.path!];
    const seen = new Set<string>();
    for (let chart = queue.shift(); chart !== undefined; chart = queue.shift()) {
      if (seen.has(chart)) continue;
      seen.add(chart);
      const yaml = await mustGit(git, ["show", `${pinSha}:${chart}/Chart.yaml`]).catch(() => {
        throw new Error(`cannot read ${chart}/Chart.yaml at ${pin.ref} (${pin.app})`);
      });
      queue.push(...parseLocalDeps(yaml, chart));
      const version = parseAppVersion(yaml);
      if (!version || !isCommitRef(version)) continue;
      builds.push({ app: pin.app, chart, commit: await resolveCommit(git, version), folder: posix.dirname(chart) });
    }
  }
  return builds;
}

async function grepRev(git: GitRunner, rev: string, key: string, folder?: string): Promise<string[]> {
  const scope = folder ? [folder, ":!*.md"] : [];
  const r = await git(["grep", "-F", "-l", "-e", key, rev, "--", ...scope]);
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
  let builds: ProdBuild[] = [];

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
    builds = await collectProdBuilds(gh, git);
    prodShas = [...new Set(builds.map((b) => b.commit))];
    const failures: string[] = [];
    for (const b of builds) {
      const code = await grepRev(git, b.commit, key, b.folder);
      if (code.length) failures.push(`${b.app} ${b.chart} @ ${b.commit.slice(0, 9)} in ${b.folder}/ (${summarize(code)})`);
    }
    return failures.length
      ? { pass: false, detail: `key found in deployed builds: ${failures.join("; ")}` }
      : { pass: true, detail: `no code references in ${builds.length} deployed builds` };
  });

  const checks = [main, org, prod];
  return { pass: checks.every((c) => c.pass), checks, builds, prodShas, docMatches: [...new Set(docMatches)] };
}
