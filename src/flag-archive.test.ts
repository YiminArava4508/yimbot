import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chartPathsOf,
  classifyMatches,
  collectProdCommits,
  parseAppVersion,
  parseArgs,
  parsePinFile,
  runFlagArchiveCheck,
  searchOrg,
  type GitRunner,
} from "./flag-archive.ts";

const PINS = `application-services-api-langserve: "b853b7d8b" # last updated on 2026-11-12
application-services-dm-email-stats: HEAD
application-services-engineering-teams-bot: main
application-services-keycloak-db: "0.3.1"
# comment
application-services-service-api-go: "0acf726d9" # last updated on 2026-11-18
application-services-workers: "0acf726d9"
`;

const FULL = (s: string) => s.padEnd(40, "0");

test("parsePinFile keeps only commit pins and skips HEAD, main and versions", () => {
  assert.deepEqual(parsePinFile(PINS), [
    { app: "application-services-api-langserve", ref: "b853b7d8b" },
    { app: "application-services-service-api-go", ref: "0acf726d9" },
    { app: "application-services-workers", ref: "0acf726d9" },
  ]);
});

test("parseAppVersion reads quoted and bare appVersion, null when absent", () => {
  assert.equal(parseAppVersion('apiVersion: v2\nappVersion: "4b0551a"\n'), "4b0551a");
  assert.equal(parseAppVersion("appVersion: a1a9658 # build\n"), "a1a9658");
  assert.equal(parseAppVersion("name: x\nversion: 0.1.0\n"), null);
});

test("chartPathsOf keeps every Chart.yaml in the tree", () => {
  const tree = ["api/chart/Chart.yaml", "api/chart/values.yaml", "react-ui/chart/Chart.yaml", "Chart.yaml.bak", "README.md"].join("\n");
  assert.deepEqual(chartPathsOf(tree), ["api/chart/Chart.yaml", "react-ui/chart/Chart.yaml"]);
});

test("classifyMatches puts .md files in docs, everything else in code", () => {
  assert.deepEqual(classifyMatches(["src/a.ts", "docs/flags.md", "README.MD", "b/c.go"]), {
    code: ["src/a.ts", "b/c.go"],
    docs: ["docs/flags.md", "README.MD"],
  });
});

test("parseArgs takes a key and optional --gemini-dir, rejects the rest", () => {
  assert.deepEqual(parseArgs(["my-flag"]), { key: "my-flag", geminiDir: null });
  assert.deepEqual(parseArgs(["my-flag", "--gemini-dir", "/g"]), { key: "my-flag", geminiDir: "/g" });
  assert.deepEqual(parseArgs(["--gemini-dir", "/g", "my-flag"]), { key: "my-flag", geminiDir: "/g" });
  assert.equal(parseArgs([]), null);
  assert.equal(parseArgs(["a", "b"]), null);
  assert.equal(parseArgs(["--gemini-dir"]), null);
  assert.equal(parseArgs(["bad key"]), null);
  assert.equal(parseArgs(["a;rm"]), null);
});

type Repo = Record<string, { files: Record<string, string> }>;

// Fake gemini repo: commits are keyed by the short names the pin file and
// Chart.yaml use; `known` lists which refs resolve locally.
function fakeGit(repo: Repo, opts: { fetchable?: string[]; failFetchMain?: boolean } = {}) {
  const calls: string[][] = [];
  const known = new Set(Object.keys(repo));
  const fetched = new Set<string>();
  const resolve = (ref: string) => {
    const name = [...known].find((k) => FULL(k) === ref || k === ref);
    return name && (!opts.fetchable?.includes(name) || fetched.has(name)) ? name : null;
  };
  const git: GitRunner = async (args) => {
    calls.push(args);
    const [cmd, ...rest] = args;
    if (cmd === "fetch") {
      if (opts.failFetchMain && rest.some((a) => a.includes("main"))) return { code: 1, stdout: "" };
      for (const a of rest) if (opts.fetchable?.includes(a)) fetched.add(a);
      return { code: 0, stdout: "" };
    }
    if (cmd === "rev-parse") {
      const name = resolve(rest[rest.length - 1]!.replace(/\^\{commit\}$/, ""));
      return name ? { code: 0, stdout: `${FULL(name)}\n` } : { code: 128, stdout: "" };
    }
    if (cmd === "ls-tree") {
      const name = resolve(rest[rest.length - 1]!);
      return name ? { code: 0, stdout: Object.keys(repo[name]!.files).join("\n") } : { code: 128, stdout: "" };
    }
    if (cmd === "show") {
      const [rev, path] = rest[0]!.split(":") as [string, string];
      const name = resolve(rev);
      const body = name ? repo[name]!.files[path] : undefined;
      return body === undefined ? { code: 128, stdout: "" } : { code: 0, stdout: body };
    }
    if (cmd === "grep") {
      const key = rest[rest.indexOf("-e") + 1]!;
      const rev = rest[rest.indexOf("-e") + 2]!;
      const name = rev === "origin/main" ? "origin/main" : resolve(rev);
      if (!name) return { code: 128, stdout: "" };
      const hits = Object.entries(repo[name]?.files ?? {}).filter(([, body]) => body.includes(key));
      return hits.length ? { code: 0, stdout: hits.map(([p]) => `${rev}:${p}`).join("\n") } : { code: 1, stdout: "" };
    }
    return { code: 2, stdout: "" };
  };
  return { git, calls };
}

const PIN_REPO: Repo = {
  "0acf726d9": {
    files: {
      "api/chart/Chart.yaml": 'appVersion: "4b0551a"\n',
      "react-ui/chart/Chart.yaml": 'appVersion: "a1a9658"\n',
      "main.go": "package main",
    },
  },
  b853b7d8b: { files: { "langserve/chart/Chart.yaml": "name: langserve\n" } },
  "4b0551a": { files: { "x.go": "package x" } },
  a1a9658: { files: { "ui.tsx": "export {}" } },
  "origin/main": { files: { "main.go": "package main" } },
};

const ghOk = (pins = PINS) => async (args: string[]) => {
  if (args.join(" ").includes("app-revisions.yaml")) return pins;
  if (args[0] === "search") return "[]";
  throw new Error(`unexpected gh ${args.join(" ")}`);
};

test("collectProdCommits returns pins plus Chart.yaml appVersions, resolved and deduped", async () => {
  const { git } = fakeGit(PIN_REPO);
  const shas = await collectProdCommits(ghOk(), git);
  assert.deepEqual(
    shas.map((s) => s.slice(0, 7)).sort(),
    ["0acf726", "4b0551a", "a1a9658", "b853b7d"].sort(),
  );
});

test("collectProdCommits fetches a commit that is missing locally", async () => {
  const { git, calls } = fakeGit(PIN_REPO, { fetchable: ["4b0551a"] });
  const shas = await collectProdCommits(ghOk(), git);
  assert.equal(shas.length, 4);
  assert.ok(calls.some((c) => c[0] === "fetch" && c.includes("4b0551a")));
});

test("collectProdCommits throws when a commit cannot be resolved", async () => {
  const repo = { ...PIN_REPO };
  delete repo["4b0551a"];
  const { git } = fakeGit(repo);
  await assert.rejects(collectProdCommits(ghOk(), git), /4b0551a/);
});

test("collectProdCommits throws when the pin file cannot be read", async () => {
  const { git } = fakeGit(PIN_REPO);
  await assert.rejects(
    collectProdCommits(async () => {
      throw new Error("gh: HTTP 502");
    }, git),
    /502/,
  );
});

test("collectProdCommits throws when no commit pins are found", async () => {
  const { git } = fakeGit(PIN_REPO);
  await assert.rejects(collectProdCommits(ghOk("a: HEAD\nb: \"0.1.0\"\n"), git), /no commit pins/i);
});

test("searchOrg retries once, then fails closed", async () => {
  let n = 0;
  const flaky = async () => {
    n++;
    if (n === 1) throw new Error("rate limited");
    return "[]";
  };
  assert.deepEqual(await searchOrg(flaky, "k"), { code: [], docs: [] });
  assert.equal(n, 2);
  let m = 0;
  await assert.rejects(
    searchOrg(async () => {
      m++;
      throw new Error("rate limited");
    }, "k"),
    /rate limited/,
  );
  assert.equal(m, 2);
});

test("searchOrg ignores gemini, splits md from code, and fails on a full page", async () => {
  const rows = [
    { repository: { nameWithOwner: "MatthewsREIS/gemini" }, path: "a.ts" },
    { repository: { nameWithOwner: "MatthewsREIS/hyperion-ai" }, path: "flags.py" },
    { repository: { nameWithOwner: "MatthewsREIS/hyperion-ai" }, path: "NOTES.md" },
  ];
  assert.deepEqual(await searchOrg(async () => JSON.stringify(rows), "k"), {
    code: ["MatthewsREIS/hyperion-ai:flags.py"],
    docs: ["MatthewsREIS/hyperion-ai:NOTES.md"],
  });
  const full = Array.from({ length: 100 }, (_, i) => ({ repository: { nameWithOwner: "o/r" }, path: `f${i}.md` }));
  await assert.rejects(searchOrg(async () => JSON.stringify(full), "k"), /too many/i);
});

test("runFlagArchiveCheck passes on a clean tree and reports prod commits", async () => {
  const { git } = fakeGit(PIN_REPO);
  const r = await runFlagArchiveCheck({ key: "old-flag", gh: ghOk(), git });
  assert.equal(r.pass, true);
  assert.equal(r.checks.length, 3);
  assert.ok(r.checks.every((c) => c.pass));
  assert.equal(r.prodShas.length, 4);
  assert.deepEqual(r.docMatches, []);
});

test("runFlagArchiveCheck fails when origin/main references the key", async () => {
  const repo: Repo = { ...PIN_REPO, "origin/main": { files: { "flags.ts": "use('old-flag')" } } };
  const { git } = fakeGit(repo);
  const r = await runFlagArchiveCheck({ key: "old-flag", gh: ghOk(), git });
  assert.equal(r.pass, false);
  const main = r.checks.find((c) => c.name === "main-gemini")!;
  assert.equal(main.pass, false);
  assert.match(main.detail, /flags\.ts/);
});

test("runFlagArchiveCheck fails when a deployed commit still references the key", async () => {
  const repo: Repo = { ...PIN_REPO, "4b0551a": { files: { "x.go": 'flag("old-flag")' } } };
  const { git } = fakeGit(repo);
  const r = await runFlagArchiveCheck({ key: "old-flag", gh: ghOk(), git });
  assert.equal(r.pass, false);
  const prod = r.checks.find((c) => c.name === "prod-commits")!;
  assert.equal(prod.pass, false);
  assert.match(prod.detail, /4b0551a/);
});

test("runFlagArchiveCheck lists .md matches without failing", async () => {
  const repo: Repo = { ...PIN_REPO, "origin/main": { files: { "docs/flags.md": "old-flag" } } };
  const { git } = fakeGit(repo);
  const r = await runFlagArchiveCheck({ key: "old-flag", gh: ghOk(), git });
  assert.equal(r.pass, true);
  assert.deepEqual(r.docMatches, ["origin/main:docs/flags.md"]);
});

test("runFlagArchiveCheck fails closed on an unresolvable prod commit", async () => {
  const repo = { ...PIN_REPO };
  delete repo.a1a9658;
  const { git } = fakeGit(repo);
  const r = await runFlagArchiveCheck({ key: "old-flag", gh: ghOk(), git });
  assert.equal(r.pass, false);
  assert.match(r.checks.find((c) => c.name === "prod-commits")!.detail, /a1a9658/);
});

test("runFlagArchiveCheck fails closed when the org search keeps erroring", async () => {
  const { git } = fakeGit(PIN_REPO);
  const gh = async (args: string[]) => {
    if (args[0] === "search") throw new Error("HTTP 403 rate limit");
    return ghOk()(args);
  };
  const r = await runFlagArchiveCheck({ key: "old-flag", gh, git });
  assert.equal(r.pass, false);
  assert.equal(r.checks.find((c) => c.name === "org-search")!.pass, false);
});

test("runFlagArchiveCheck fails closed when origin/main cannot be fetched", async () => {
  const { git } = fakeGit(PIN_REPO, { failFetchMain: true });
  const r = await runFlagArchiveCheck({ key: "old-flag", gh: ghOk(), git });
  assert.equal(r.pass, false);
  assert.equal(r.checks.find((c) => c.name === "main-gemini")!.pass, false);
});

test("runFlagArchiveCheck fails closed when git grep errors (exit above 1)", async () => {
  const { git } = fakeGit(PIN_REPO);
  const broken: GitRunner = async (args) => (args[0] === "grep" ? { code: 128, stdout: "" } : git(args));
  const r = await runFlagArchiveCheck({ key: "old-flag", gh: ghOk(), git: broken });
  assert.equal(r.pass, false);
  assert.ok(r.checks.filter((c) => !c.pass).length >= 2);
});

test("runFlagArchiveCheck uses fixed-string grep over the whole tree", async () => {
  const { git, calls } = fakeGit(PIN_REPO);
  await runFlagArchiveCheck({ key: "old-flag", gh: ghOk(), git });
  const greps = calls.filter((c) => c[0] === "grep");
  assert.equal(greps.length, 5);
  for (const g of greps) {
    assert.ok(g.includes("-F"));
    assert.ok(g.includes("-e"));
  }
});
