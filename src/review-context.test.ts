// src/review-context.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff } from "./review-diff.ts";
import {
  CONTEXT_RELPATH,
  contextFilePath,
  contextMarkdown,
  contextSignature,
  patchText,
  togglePin,
} from "./review-context.ts";

const RAW = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@ function foo()",
  "-old line",
  "+new line",
  " ctx",
  "diff --git a/src/b.ts b/src/b.ts",
  "index 333..444 100644",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -5 +5 @@",
  "-x",
  "+y",
  "",
].join("\n");

test("patchText keeps hunk headers and +/- prefixes, drops meta lines", () => {
  const [a] = parseUnifiedDiff(RAW);
  assert.equal(patchText(a), "@@ -1,2 +1,2 @@ function foo()\n-old line\n+new line\n ctx");
});

test("togglePin adds then removes without mutating the input set", () => {
  const start = new Set<string>();
  const pinned = togglePin(start, "src/b.ts");
  assert.ok(pinned.has("src/b.ts"));
  assert.equal(start.size, 0);
  assert.ok(!togglePin(pinned, "src/b.ts").has("src/b.ts"));
});

test("contextSignature changes on selection or pin change, ignores pin order", () => {
  const s1 = contextSignature("src/a.ts", new Set(["x", "y"]));
  assert.equal(s1, contextSignature("src/a.ts", new Set(["y", "x"])));
  assert.notEqual(s1, contextSignature("src/b.ts", new Set(["x", "y"])));
  assert.notEqual(s1, contextSignature("src/a.ts", new Set(["x"])));
});

test("contextMarkdown puts the selected file first and skips a pin equal to it", () => {
  const diffs = parseUnifiedDiff(RAW);
  const md = contextMarkdown(7, "src/a.ts", new Set(["src/a.ts", "src/b.ts"]), diffs);
  assert.ok(md.startsWith("# Review context: PR #7"));
  const cur = md.indexOf("## Current file: src/a.ts");
  const pin = md.indexOf("## Pinned: src/b.ts");
  assert.ok(cur >= 0 && pin > cur);
  assert.equal(md.indexOf("## Pinned: src/a.ts"), -1);
  assert.ok(md.includes("```diff\n@@ -5 +5 @@\n-x\n+y\n```"));
});

test("contextMarkdown notes when nothing is selected or pinned", () => {
  const md = contextMarkdown(7, null, new Set(), parseUnifiedDiff(RAW));
  assert.ok(md.includes("(no file selected)"));
});

test("contextFilePath joins cwd with the fixed relpath", () => {
  assert.equal(contextFilePath("/tmp/wt"), `/tmp/wt/${CONTEXT_RELPATH}`);
});
