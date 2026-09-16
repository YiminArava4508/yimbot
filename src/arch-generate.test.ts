import { test } from "node:test";
import assert from "node:assert/strict";
import { mapPrompt, parseGeneratedMap, sourcePaths } from "./arch-generate.ts";

test("sourcePaths keeps source and drops lockfiles, tests and vendored trees", () => {
  const out = sourcePaths([
    "src/gh.ts", "src/gh.test.ts", "pnpm-lock.yaml", "node_modules/x/index.js",
    "scripts/onboard.ts", "README.md", "dist/bundle.js", "docs/a.md",
  ]);
  assert.deepEqual(out, ["src/gh.ts", "scripts/onboard.ts"]);
});

test("mapPrompt lists every path and asks for the node shape", () => {
  const p = mapPrompt(["src/gh.ts", "src/tui.ts"]);
  assert.ok(p.includes("src/gh.ts"));
  assert.ok(p.includes("src/tui.ts"));
  assert.ok(p.includes('"nodes"'));
  assert.ok(p.includes('"edges"'));
});

test("parseGeneratedMap stamps the commit and validates the shape", () => {
  const raw = `here\n${JSON.stringify({
    nodes: [{ id: "gh", label: "gh", role: "GitHub", files: ["src/gh.ts"] }],
    edges: [],
  })}`;
  const m = parseGeneratedMap(raw, "abc123");
  assert.equal(m?.commit, "abc123");
  assert.equal(m?.nodes[0].id, "gh");
  assert.ok((m?.generatedAt ?? "") !== "");
});

test("parseGeneratedMap rejects output with no usable nodes", () => {
  assert.equal(parseGeneratedMap("no json", "abc"), null);
  assert.equal(parseGeneratedMap(JSON.stringify({ nodes: [] }), "abc"), null);
});
