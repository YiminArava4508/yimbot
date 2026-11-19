import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyMatches,
  collectProdBuilds,
  parseAppCharts,
  parseAppVersion,
  parseArgs,
  parseLocalDeps,
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


const TF = `locals {
  application_services_apps = {
    "application-services-api-langserve" = { path = "api-langserve/chart", dest_namespace = "service-api-go", release_name = "api-langserve" }
    "application-services-artemis-mcp" = {
      path  = "artemis-mcp/chart", dest_namespace = "service-api-go", release_name = "artemis-mcp"
      retry = null, sync_options = ["CreateNamespace=true", "PruneLast=true"]
    }
    "application-services-dm-email-stats"        = { repo_url = "https://github.com/MatthewsREIS/automated_tasks", path = "dm-email-stats/chart", dest_namespace = "reporting" }
    "application-services-engineering-teams-bot" = { path = "engineering-teams-bot/chart", dest_namespace = "engineering-teams-bot" }
    "application-services-service-api-go" = {
      path        = "api/chart", dest_namespace = "service-api-go", release_name = "service-api-go"
      annotations = { "notifications.argoproj.io/subscribe.on-sync-succeeded.artemis" = "" }
      ignore_differences = [{ group = "postgresql.cnpg.io", kind = "Cluster", jsonPointers = ["/spec/postgresql/pg_ident"] }]
    }
    "application-services-valkey" = { repo_url = "https://valkey.io/valkey-helm/", chart = "valkey", dest_namespace = "ratelimit" }
    "application-services-workers" = {
      path         = "workers/chart", dest_namespace = "service-api-go", release_name = "workers"
      values_file  = "application-services-service-api-go"
    }
  }

  application_services_elements = [for name, app in local.application_services_apps : { name = name }]
}
`;

test("parseAppCharts reads each app's chart path and repo, one-line and multi-line entries", () => {
  assert.deepEqual(parseAppCharts(TF), [
    { app: "application-services-api-langserve", path: "api-langserve/chart", repoUrl: null },
    { app: "application-services-artemis-mcp", path: "artemis-mcp/chart", repoUrl: null },
    { app: "application-services-dm-email-stats", path: "dm-email-stats/chart", repoUrl: "https://github.com/MatthewsREIS/automated_tasks" },
    { app: "application-services-engineering-teams-bot", path: "engineering-teams-bot/chart", repoUrl: null },
    { app: "application-services-service-api-go", path: "api/chart", repoUrl: null },
    { app: "application-services-valkey", path: null, repoUrl: "https://valkey.io/valkey-helm/" },
    { app: "application-services-workers", path: "workers/chart", repoUrl: null },
  ]);
});

test("parseAppCharts throws when the apps map is missing", () => {
  assert.throws(() => parseAppCharts("locals {}"), /application_services_apps/);
});

test("parseLocalDeps resolves file:// subcharts against the chart folder and ignores remote ones", () => {
  const chart = [
    "dependencies:",
    "  - name: cluster",
    "    repository: https://cloudnative-pg.github.io/charts",
    "  - name: react-ui",
    '    repository: "file://../../react-ui/chart"',
    "  - name: other",
    "    repository: file://../shared/chart",
  ].join("\n");
  assert.deepEqual(parseLocalDeps(chart, "api/chart"), ["react-ui/chart", "api/shared/chart"]);
});

type Repo = Record<string, { files: Record<string, string> }>;

// Fake gemini repo: commits are keyed by the short names the pin file and
// Chart.yaml use; `fetchable` lists commits that only resolve after a fetch.
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
    if (cmd === "show") {
      const [rev, path] = rest[0]!.split(":") as [string, string];
      const name = resolve(rev);
      const body = name ? repo[name]!.files[path] : undefined;
      return body === undefined ? { code: 128, stdout: "" } : { code: 0, stdout: body };
    }
    if (cmd === "grep") {
      const key = rest[rest.indexOf("-e") + 1]!;
      const rev = rest[rest.indexOf("-e") + 2]!;
      const dir = rest[rest.indexOf("--") + 1] ?? ".";
      const name = rev === "origin/main" ? "origin/main" : resolve(rev);
      if (!name) return { code: 128, stdout: "" };
      const skipMd = rest.includes(":!*.md");
      const inDir = (p: string) => dir === "." || p.startsWith(`${dir}/`);
      const hits = Object.entries(repo[name]?.files ?? {}).filter(
        ([p, body]) => inDir(p) && !(skipMd && p.endsWith(".md")) && body.includes(key),
      );
      return hits.length ? { code: 0, stdout: hits.map(([p]) => `${rev}:${p}`).join("\n") } : { code: 1, stdout: "" };
    }
    return { code: 2, stdout: "" };
  };
  return { git, calls };
}

const API_CHART = `appVersion: "4b0551a"
dependencies:
  - name: cluster
    repository: https://cloudnative-pg.github.io/charts
  - name: react-ui
    repository: "file://../../react-ui/chart"
`;

// The real 2026-11-19 layout: api's image is built at 4b0551a (which still
// carries react-ui source), react-ui at a1a9658 (which dropped the flags).
const PIN_REPO: Repo = {
  "0acf726d9": {
    files: {
      "api/chart/Chart.yaml": API_CHART,
      "react-ui/chart/Chart.yaml": 'appVersion: "a1a9658"\n',
      "workers/chart/Chart.yaml": 'appVersion: "4b0551a"\n',
    },
  },
  "1d0e5b6d6": { files: { "artemis-mcp/chart/Chart.yaml": 'appVersion: "1d0e5b6d6"\n', "artemis-mcp/main.py": "x = 1" } },
  b853b7d8b: {
    files: {
      "api-langserve/chart/Chart.yaml": 'appVersion: "b853b7d8b"\n',
      "api-langserve/main.py": "x = 1",
      "react-ui/src/old.tsx": "useFlag('old-flag')",
    },
  },
  "4b0551a": {
    files: { "api/main.go": "package main", "workers/w.go": "package w", "react-ui/src/flag.tsx": "useFlag('old-flag')" },
  },
  a1a9658: { files: { "react-ui/src/ui.tsx": "export {}" } },
  "origin/main": { files: { "main.go": "package main" } },
};

const ghOk = (pins = PINS, tf = TF) => async (args: string[]) => {
  const joined = args.join(" ");
  if (joined.includes("app-revisions.yaml")) return pins;
  if (joined.includes("application-services.tf")) return tf;
  if (args[0] === "search") return "[]";
  throw new Error(`unexpected gh ${joined}`);
};

const PROD_PINS = `application-services-api-langserve: "b853b7d8b"
application-services-artemis-mcp: "1d0e5b6d6"
application-services-dm-email-stats: HEAD
application-services-engineering-teams-bot: main
application-services-service-api-go: "0acf726d9"
application-services-valkey: "0.9.4"
application-services-workers: "0acf726d9"
`;

const short = (b: { app: string; chart: string; commit: string; folder: string }) =>
  `${b.app.replace("application-services-", "")} ${b.chart} ${b.commit.slice(0, 7)} ${b.folder}`;

test("collectProdBuilds returns one build per chart appVersion, following local subcharts", async () => {
  const { git } = fakeGit(PIN_REPO);
  const builds = await collectProdBuilds(ghOk(PROD_PINS), git);
  assert.deepEqual(builds.map(short).sort(), [
    "api-langserve api-langserve/chart b853b7d api-langserve",
    "artemis-mcp artemis-mcp/chart 1d0e5b6 artemis-mcp",
    "service-api-go api/chart 4b0551a api",
    "service-api-go react-ui/chart a1a9658 react-ui",
    "workers workers/chart 4b0551a workers",
  ]);
});

test("collectProdBuilds skips semver and branch versions, other repos and helm-repo charts", async () => {
  const repo: Repo = {
    ...PIN_REPO,
    "0acf726d9": {
      files: {
        "api/chart/Chart.yaml": 'appVersion: "26.8.1"\ndependencies:\n  - name: react-ui\n    repository: "file://../../react-ui/chart"\n',
        "react-ui/chart/Chart.yaml": "appVersion: HEAD\n",
        "workers/chart/Chart.yaml": 'appVersion: "0.0.0"\n',
      },
    },
  };
  const { git } = fakeGit(repo);
  const builds = await collectProdBuilds(ghOk(PROD_PINS), git);
  assert.deepEqual(builds.map(short).sort(), [
    "api-langserve api-langserve/chart b853b7d api-langserve",
    "artemis-mcp artemis-mcp/chart 1d0e5b6 artemis-mcp",
  ]);
});

test("collectProdBuilds fetches a commit that is missing locally", async () => {
  const { git, calls } = fakeGit(PIN_REPO, { fetchable: ["4b0551a"] });
  const builds = await collectProdBuilds(ghOk(PROD_PINS), git);
  assert.equal(builds.length, 5);
  assert.ok(calls.some((c) => c[0] === "fetch" && c.includes("4b0551a")));
});

test("collectProdBuilds throws when a commit cannot be resolved", async () => {
  const repo = { ...PIN_REPO };
  delete repo["4b0551a"];
  const { git } = fakeGit(repo);
  await assert.rejects(collectProdBuilds(ghOk(PROD_PINS), git), /4b0551a/);
});

test("collectProdBuilds throws when a pinned chart has no Chart.yaml", async () => {
  const repo = { ...PIN_REPO, "1d0e5b6d6": { files: {} } };
  const { git } = fakeGit(repo);
  await assert.rejects(collectProdBuilds(ghOk(PROD_PINS), git), /artemis-mcp\/chart\/Chart\.yaml/);
});

test("collectProdBuilds throws when the pin file or the terraform file cannot be read", async () => {
  const { git } = fakeGit(PIN_REPO);
  const broken = (needle: string) => async (args: string[]) => {
    if (args.join(" ").includes(needle)) throw new Error("gh: HTTP 502");
    return ghOk(PROD_PINS)(args);
  };
  await assert.rejects(collectProdBuilds(broken("app-revisions.yaml"), git), /502/);
  await assert.rejects(collectProdBuilds(broken("application-services.tf"), git), /502/);
});

test("collectProdBuilds throws when no commit pins are found", async () => {
  const { git } = fakeGit(PIN_REPO);
  await assert.rejects(collectProdBuilds(ghOk('a: HEAD\nb: "0.1.0"\n'), git), /no commit pins/i);
});

test("collectProdBuilds throws when a pinned app is missing from the terraform map", async () => {
  const { git } = fakeGit(PIN_REPO);
  await assert.rejects(collectProdBuilds(ghOk('ghost-app: "0acf726d9"\n'), git), /ghost-app/);
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

const runner = (pins = PROD_PINS) => ghOk(pins);

test("runFlagArchiveCheck passes on the 2026-11-19 layout: key still in react-ui at the api commit, absent at the react-ui commit", async () => {
  const { git } = fakeGit(PIN_REPO);
  const r = await runFlagArchiveCheck({ key: "old-flag", gh: runner(), git });
  assert.equal(r.pass, true);
  assert.equal(r.checks.length, 3);
  assert.ok(r.checks.every((c) => c.pass));
  assert.deepEqual(r.builds.map(short).sort(), [
    "api-langserve api-langserve/chart b853b7d api-langserve",
    "artemis-mcp artemis-mcp/chart 1d0e5b6 artemis-mcp",
    "service-api-go api/chart 4b0551a api",
    "service-api-go react-ui/chart a1a9658 react-ui",
    "workers workers/chart 4b0551a workers",
  ]);
  assert.deepEqual(
    r.prodShas.map((s) => s.slice(0, 7)).sort(),
    ["1d0e5b6", "4b0551a", "a1a9658", "b853b7d"],
  );
  assert.deepEqual(r.docMatches, []);
});

test("runFlagArchiveCheck fails when origin/main references the key", async () => {
  const repo: Repo = { ...PIN_REPO, "origin/main": { files: { "flags.ts": "use('old-flag')" } } };
  const { git } = fakeGit(repo);
  const r = await runFlagArchiveCheck({ key: "old-flag", gh: runner(), git });
  assert.equal(r.pass, false);
  const main = r.checks.find((c) => c.name === "main-gemini")!;
  assert.equal(main.pass, false);
  assert.match(main.detail, /flags\.ts/);
});

test("runFlagArchiveCheck fails when the react-ui build prod runs still has the key", async () => {
  const repo: Repo = { ...PIN_REPO, a1a9658: { files: { "react-ui/src/ui.tsx": "useFlag('old-flag')" } } };
  const { git } = fakeGit(repo);
  const r = await runFlagArchiveCheck({ key: "old-flag", gh: runner(), git });
  assert.equal(r.pass, false);
  const prod = r.checks.find((c) => c.name === "prod-commits")!;
  assert.equal(prod.pass, false);
  assert.match(prod.detail, /service-api-go/);
  assert.match(prod.detail, /react-ui\/chart/);
  assert.match(prod.detail, /a1a9658/);
});

test("runFlagArchiveCheck fails when the api folder at the api commit has the key", async () => {
  const repo: Repo = { ...PIN_REPO, "4b0551a": { files: { "api/main.go": "flag(\"old-flag\")" } } };
  const { git } = fakeGit(repo);
  const r = await runFlagArchiveCheck({ key: "old-flag", gh: runner(), git });
  assert.equal(r.pass, false);
  assert.match(r.checks.find((c) => c.name === "prod-commits")!.detail, /api\/chart.*4b0551a/);
});

test("runFlagArchiveCheck lists .md matches on main without failing", async () => {
  const repo: Repo = { ...PIN_REPO, "origin/main": { files: { "docs/flags.md": "old-flag" } } };
  const { git } = fakeGit(repo);
  const r = await runFlagArchiveCheck({ key: "old-flag", gh: runner(), git });
  assert.equal(r.pass, true);
  assert.deepEqual(r.docMatches, ["origin/main:docs/flags.md"]);
});

test("runFlagArchiveCheck fails closed on an unresolvable prod commit", async () => {
  const repo = { ...PIN_REPO };
  delete repo.a1a9658;
  const { git } = fakeGit(repo);
  const r = await runFlagArchiveCheck({ key: "old-flag", gh: runner(), git });
  assert.equal(r.pass, false);
  assert.match(r.checks.find((c) => c.name === "prod-commits")!.detail, /a1a9658/);
});

test("runFlagArchiveCheck fails closed when the org search keeps erroring", async () => {
  const { git } = fakeGit(PIN_REPO);
  const gh = async (args: string[]) => {
    if (args[0] === "search") throw new Error("HTTP 403 rate limit");
    return runner()(args);
  };
  const r = await runFlagArchiveCheck({ key: "old-flag", gh, git });
  assert.equal(r.pass, false);
  assert.equal(r.checks.find((c) => c.name === "org-search")!.pass, false);
});

test("runFlagArchiveCheck fails closed when origin/main cannot be fetched", async () => {
  const { git } = fakeGit(PIN_REPO, { failFetchMain: true });
  const r = await runFlagArchiveCheck({ key: "old-flag", gh: runner(), git });
  assert.equal(r.pass, false);
  assert.equal(r.checks.find((c) => c.name === "main-gemini")!.pass, false);
});

test("runFlagArchiveCheck fails closed when git grep errors (exit above 1)", async () => {
  const { git } = fakeGit(PIN_REPO);
  const broken: GitRunner = async (args) => (args[0] === "grep" ? { code: 128, stdout: "" } : git(args));
  const r = await runFlagArchiveCheck({ key: "old-flag", gh: runner(), git: broken });
  assert.equal(r.pass, false);
  assert.ok(r.checks.filter((c) => !c.pass).length >= 2);
});

test("prod greps are fixed-string, scoped to the build's folder, and skip markdown", async () => {
  const { git, calls } = fakeGit(PIN_REPO);
  await runFlagArchiveCheck({ key: "old-flag", gh: runner(), git });
  const prodGreps = calls.filter((c) => c[0] === "grep" && !c.includes("origin/main"));
  assert.equal(prodGreps.length, 5);
  for (const g of prodGreps) {
    assert.ok(g.includes("-F"));
    assert.ok(g.includes("-e"));
    assert.deepEqual(g.slice(-3, -1), ["--", g[g.length - 2]]);
    assert.equal(g[g.length - 1], ":!*.md");
  }
  const folders = prodGreps.map((g) => g[g.length - 2]).sort();
  assert.deepEqual(folders, ["api", "api-langserve", "artemis-mcp", "react-ui", "workers"]);
});
