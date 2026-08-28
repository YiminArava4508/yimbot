import { test } from "node:test";
import assert from "node:assert/strict";
import { fallbackGroups, fetchGroups, groupingPrompt, parseGroups } from "./review-groups.ts";

const PR = { number: 42, title: "add widget", body: "makes widgets" };
const FILES = [
  { path: "src/widget.ts", additions: 10, deletions: 2 },
  { path: "src/widget.test.ts", additions: 30, deletions: 0 },
  { path: "docs/widget.md", additions: 5, deletions: 1 },
];
const PATHS = FILES.map((f) => f.path);

test("groupingPrompt names the PR and lists every path with its diffstat", () => {
  const p = groupingPrompt(PR, FILES);
  assert.ok(p.includes("PR #42: add widget"));
  assert.ok(p.includes("makes widgets"));
  for (const f of FILES) assert.ok(p.includes(`- ${f.path} (+${f.additions}/-${f.deletions})`));
  assert.ok(p.includes("ONLY a JSON object"));
});

test("parseGroups survives prose around the JSON", () => {
  const raw = 'Sure! Here you go:\n{"summary":"s","groups":[{"title":"core","context":"c","files":["src/widget.ts","src/widget.test.ts","docs/widget.md"]}]}\nDone.';
  const g = parseGroups(raw, PATHS);
  assert.ok(g);
  assert.equal(g.summary, "s");
  assert.equal(g.groups.length, 1);
  assert.deepEqual(g.groups[0].files, PATHS);
});

test("parseGroups drops unknown paths and duplicates, appends missing files as Other changes", () => {
  const raw = JSON.stringify({
    summary: "s",
    groups: [{ title: "core", context: "c", files: ["src/widget.ts", "src/widget.ts", "made/up.ts"] }],
  });
  const g = parseGroups(raw, PATHS);
  assert.ok(g);
  assert.deepEqual(g.groups[0].files, ["src/widget.ts"]);
  const last = g.groups.at(-1);
  assert.equal(last?.title, "Other changes");
  assert.deepEqual(last?.files, ["src/widget.test.ts", "docs/widget.md"]);
});

test("parseGroups returns null for junk, empty groups, and groups with no valid files", () => {
  assert.equal(parseGroups("no json here", PATHS), null);
  assert.equal(parseGroups('{"summary":"s","groups":[]}', PATHS), null);
  assert.equal(parseGroups('{"summary":"s","groups":[{"title":"t","context":"c","files":["nope.ts"]}]}', PATHS), null);
});

test("fallbackGroups buckets by top-level directory, alphabetical", () => {
  const g = fallbackGroups(["src/b.ts", "docs/a.md", "src/a.ts", "README.md"]);
  assert.equal(g.summary, "");
  assert.deepEqual(g.groups.map((x) => x.title), ["(root)", "docs", "src"]);
  assert.deepEqual(g.groups[2].files, ["src/a.ts", "src/b.ts"]);
});

test("fetchGroups uses the parsed answer when valid", async () => {
  const raw = JSON.stringify({ summary: "s", groups: [{ title: "all", context: "c", files: PATHS }] });
  const { groups, usedFallback } = await fetchGroups(async () => raw, PR, FILES);
  assert.equal(usedFallback, false);
  assert.equal(groups.groups[0].title, "all");
});

test("fetchGroups falls back when the runner throws or returns junk", async () => {
  const thrown = await fetchGroups(async () => { throw new Error("boom"); }, PR, FILES);
  assert.equal(thrown.usedFallback, true);
  assert.ok(thrown.groups.groups.length > 0);
  const junk = await fetchGroups(async () => "not json", PR, FILES);
  assert.equal(junk.usedFallback, true);
});
