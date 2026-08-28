import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff, escapeTags, languageFor, renderFileDiff, type FileDiff } from "./review-diff.ts";

const TWO_FILE_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " const keep = 1;",
  "-const old = 2;",
  "+const fresh = 2;",
  "+const added = 3;",
  "diff --git a/README.md b/README.md",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/README.md",
  "@@ -0,0 +1,1 @@",
  "+# hello",
  "",
].join("\n");

test("parseUnifiedDiff splits files and counts additions and deletions per file", () => {
  const files = parseUnifiedDiff(TWO_FILE_DIFF);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, "src/a.ts");
  assert.equal(files[0].status, "modified");
  assert.equal(files[0].additions, 2);
  assert.equal(files[0].deletions, 1);
  assert.equal(files[1].path, "README.md");
  assert.equal(files[1].status, "added");
  assert.equal(files[1].additions, 1);
  assert.equal(files[1].deletions, 0);
});

test("parseUnifiedDiff classifies hunk body lines and keeps hunk headers", () => {
  const [f] = parseUnifiedDiff(TWO_FILE_DIFF);
  const kinds = f.lines.map((l) => l.kind);
  assert.deepEqual(kinds, ["meta", "meta", "meta", "hunk", "ctx", "del", "add", "add"]);
  assert.equal(f.lines[3].text, "@@ -1,3 +1,4 @@");
});

test("parseUnifiedDiff marks renames and uses the new path", () => {
  const diff = [
    "diff --git a/src/old.ts b/src/new.ts",
    "similarity index 100%",
    "rename from src/old.ts",
    "rename to src/new.ts",
    "",
  ].join("\n");
  const [f] = parseUnifiedDiff(diff);
  assert.equal(f.status, "renamed");
  assert.equal(f.path, "src/new.ts");
  assert.equal(f.oldPath, "src/old.ts");
});

test("parseUnifiedDiff marks deleted and binary files", () => {
  const diff = [
    "diff --git a/gone.ts b/gone.ts",
    "deleted file mode 100644",
    "index 1111111..0000000",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1,1 +0,0 @@",
    "-bye",
    "diff --git a/logo.png b/logo.png",
    "index 4444444..5555555 100644",
    "Binary files a/logo.png and b/logo.png differ",
    "",
  ].join("\n");
  const files = parseUnifiedDiff(diff);
  assert.equal(files[0].status, "deleted");
  assert.equal(files[0].deletions, 1);
  assert.equal(files[1].status, "binary");
  assert.equal(files[1].additions, 0);
});

test("parseUnifiedDiff returns [] for empty input", () => {
  assert.deepEqual(parseUnifiedDiff(""), []);
});

test("parseUnifiedDiff does not misread a hunk body line starting with --- as a header", () => {
  const diff = [
    "diff --git a/x.md b/x.md",
    "index 1..2 100644",
    "--- a/x.md",
    "+++ b/x.md",
    "@@ -1,1 +1,1 @@",
    "----",
    "+***",
    "",
  ].join("\n");
  const [f] = parseUnifiedDiff(diff);
  assert.equal(f.deletions, 1);
  assert.equal(f.additions, 1);
});

test("escapeTags neutralizes blessed tag braces", () => {
  assert.equal(escapeTags("const x = {a: 1};"), "const x = {open}a: 1{close};");
});

test("renderFileDiff keeps the header, hunks cyan, and skips meta", () => {
  const [f] = parseUnifiedDiff(TWO_FILE_DIFF);
  const out = renderFileDiff(f);
  assert.equal(out[0], "{bold}src/a.ts{/bold}  {green-fg}+2{/green-fg} {red-fg}-1{/red-fg}");
  assert.ok(out.includes("{cyan-fg}@@ -1,3 +1,4 @@{/cyan-fg}"));
  assert.ok(!out.some((l) => l.includes("index 1111111")));
});

test("languageFor maps known extensions and returns null otherwise", () => {
  assert.equal(languageFor("src/a.ts"), "typescript");
  assert.equal(languageFor("web/App.tsx"), "typescript");
  assert.equal(languageFor("lib/x.js"), "javascript");
  assert.equal(languageFor("tool.py"), "python");
  assert.equal(languageFor("run.sh"), "bash");
  assert.equal(languageFor("data.json"), "json");
  assert.equal(languageFor("README.md"), "markdown");
  assert.equal(languageFor("ci.yml"), "yaml");
  assert.equal(languageFor("main.go"), "go");
  assert.equal(languageFor("lib.rs"), "rust");
  assert.equal(languageFor("style.css"), "css");
  assert.equal(languageFor("logo.png"), null);
  assert.equal(languageFor("Makefile"), null);
});

test("renderFileDiff syntax-highlights recognized files with tinted add/del lines", () => {
  const [f] = parseUnifiedDiff(TWO_FILE_DIFF);
  const out = renderFileDiff(f);
  const add = out.find((l) => l.includes("fresh"));
  assert.ok(add);
  assert.ok(add.startsWith("{22-bg}{green-fg}+{/green-fg}"));
  assert.ok(add.endsWith("{/22-bg}"));
  assert.ok(add.includes("{magenta-fg}const{/magenta-fg}"));
  assert.ok(!add.includes("{green-fg}+const"));
  const del = out.find((l) => l.includes("old = "));
  assert.ok(del);
  assert.ok(del.startsWith("{52-bg}{red-fg}-{/red-fg}"));
  assert.ok(del.endsWith("{/52-bg}"));
  const ctx = out.find((l) => l.includes("keep"));
  assert.ok(ctx);
  assert.ok(ctx.startsWith(" "));
  assert.ok(ctx.includes("{magenta-fg}const{/magenta-fg}"));
});

test("renderFileDiff emits only blessed tags, no raw ANSI escapes or sentinels", () => {
  const [f] = parseUnifiedDiff(TWO_FILE_DIFF);
  for (const line of renderFileDiff(f)) {
    assert.ok(!line.includes(String.fromCharCode(27)));
    assert.ok(!line.includes(String.fromCharCode(1)));
    assert.ok(!line.includes(String.fromCharCode(2)));
  }
});

test("renderFileDiff escapes braces inside highlighted code lines", () => {
  const f: FileDiff = {
    path: "x.ts", oldPath: "x.ts", status: "modified", additions: 1, deletions: 0,
    lines: [{ kind: "add", text: "+const o = {};" }],
  };
  const [, line] = renderFileDiff(f);
  assert.ok(line.includes("{open}"));
  assert.ok(line.includes("{close}"));
});

test("renderFileDiff falls back to whole-line coloring for unrecognized files", () => {
  const f: FileDiff = {
    path: "notes.zzz", oldPath: "notes.zzz", status: "modified", additions: 1, deletions: 1,
    lines: [
      { kind: "add", text: "+hello there" },
      { kind: "del", text: "-goodbye" },
    ],
  };
  const out = renderFileDiff(f);
  assert.ok(out.includes("{green-fg}+hello there{/green-fg}"));
  assert.ok(out.includes("{red-fg}-goodbye{/red-fg}"));
});

test("renderFileDiff shows the rename arrow and a binary stub", () => {
  const renamed: FileDiff = {
    path: "b.ts", oldPath: "a.ts", status: "renamed", additions: 0, deletions: 0, lines: [],
  };
  assert.ok(renderFileDiff(renamed)[0].includes("a.ts -> b.ts"));
  const binary: FileDiff = {
    path: "logo.png", oldPath: "logo.png", status: "binary", additions: 0, deletions: 0, lines: [],
  };
  assert.ok(renderFileDiff(binary).includes("{grey-fg}binary file, no text diff{/grey-fg}"));
});
