import { test } from "node:test";
import assert from "node:assert/strict";
import blessed from "neo-blessed";
import { parseUnifiedDiff, escapeTags, languageFor, renderFileDiff, renderSideBySide, sideBySideRows, warmHighlighter, type FileDiff, type SideCell } from "./review-diff.ts";

const strWidth = (s: string) => blessed.unicode.strWidth(s);
function untag(m: string): string {
  if (m === "{open}") return "{";
  if (m === "{close}") return "}";
  return "";
}
const visible = (s: string) => s.replace(/\{[^}]*\}/g, untag);

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
  const out = renderFileDiff(f, 80);
  assert.equal(out[0], "{bold}src/a.ts{/bold}  {green-fg}+2{/green-fg} {red-fg}-1{/red-fg}");
  assert.ok(out.includes("{cyan-fg}@@ -1,3 +1,4 @@{/cyan-fg}"));
  assert.ok(!out.some((l) => l.includes("index 1111111")));
});

test("languageFor maps known extensions and names and returns null otherwise", () => {
  assert.equal(languageFor("src/a.ts"), "typescript");
  assert.equal(languageFor("web/App.tsx"), "tsx");
  assert.equal(languageFor("lib/x.js"), "javascript");
  assert.equal(languageFor("tool.py"), "python");
  assert.equal(languageFor("run.sh"), "bash");
  assert.equal(languageFor("data.json"), "json");
  assert.equal(languageFor("README.md"), "markdown");
  assert.equal(languageFor("ci.yml"), "yaml");
  assert.equal(languageFor("main.go"), "go");
  assert.equal(languageFor("lib.rs"), "rust");
  assert.equal(languageFor("style.css"), "css");
  assert.equal(languageFor("page.html"), "html");
  assert.equal(languageFor("App.vue"), "vue");
  assert.equal(languageFor("Cargo.toml"), "toml");
  assert.equal(languageFor("schema.graphql"), "graphql");
  assert.equal(languageFor("query.gql"), "graphql");
  assert.equal(languageFor("infra/main.tf"), "terraform");
  assert.equal(languageFor("prod.tfvars"), "terraform");
  assert.equal(languageFor("cfg.hcl"), "hcl");
  assert.equal(languageFor("schema.prisma"), "prisma");
  assert.equal(languageFor("docker/Dockerfile"), "dockerfile");
  assert.equal(languageFor("Makefile"), "makefile");
  assert.equal(languageFor("logo.png"), null);
  assert.equal(languageFor("notes"), null);
});

// VSCode Dark+ token colors, as shiki reports them for the theme.
const KEYWORD = "#569cd6";
const CONTROL = "#c586c0";
const VARIABLE = "#9cdcfe";
const CONSTANT = "#4fc1ff";
const FUNCTION = "#dcdcaa";
const STRING = "#ce9178";
const NUMBER = "#b5cea8";
const COMMENT = "#6a9955";
const TYPE = "#4ec9b0";
const GUTTER = "#858585";
const ADD_BG = "#005f00";
const DEL_BG = "#5f0000";

const fg = (color: string, text: string) => `{${color}-fg}${text}{/${color}-fg}`;

test("renderFileDiff colors tokens with the Dark+ palette and tints changed rows", () => {
  const [f] = parseUnifiedDiff(TWO_FILE_DIFF);
  const out = renderFileDiff(f, 60);
  const add = out.find((l) => l.includes("fresh"));
  assert.ok(add);
  assert.ok(add.startsWith(`{${ADD_BG}-bg}`), add);
  assert.ok(add.endsWith(`{/${ADD_BG}-bg}`), add);
  assert.ok(add.includes(fg(KEYWORD, "const")), add);
  assert.ok(add.includes(fg(CONSTANT, "fresh")), add);
  assert.ok(add.includes(fg(NUMBER, "2")), add);
  const del = out.find((l) => visible(l).includes("old = "));
  assert.ok(del);
  assert.ok(del.startsWith(`{${DEL_BG}-bg}`), del);
  assert.ok(del.includes(fg(KEYWORD, "const")), del);
  const ctx = out.find((l) => l.includes("keep"));
  assert.ok(ctx);
  assert.ok(!ctx.includes("-bg}"), ctx);
  assert.ok(ctx.includes(fg(KEYWORD, "const")), ctx);
});

test("renderFileDiff puts old and new line numbers and a sign in a dim gutter, padded to the width", () => {
  const [f] = parseUnifiedDiff(TWO_FILE_DIFF);
  const width = 60;
  const out = renderFileDiff(f, width);
  const rows = out.slice(2);
  for (const l of rows) assert.equal(visible(l).length, width, JSON.stringify(visible(l)));
  assert.equal(visible(rows[0]).slice(0, 10), "  1   1   ");
  assert.equal(visible(rows[1]).slice(0, 10), "  2     - ");
  assert.equal(visible(rows[2]).slice(0, 10), "      2 + ");
  assert.equal(visible(rows[3]).slice(0, 10), "      3 + ");
  assert.ok(rows[1].includes(`{${GUTTER}-fg}`), rows[1]);
  assert.ok(rows[1].includes("{red-fg}-{/red-fg}"), rows[1]);
  assert.ok(rows[2].includes("{green-fg}+{/green-fg}"), rows[2]);
});

test("renderFileDiff widens the gutter for long files and keeps rows at the width", () => {
  const diff = ["diff --git a/b.ts b/b.ts", "index 1..2 100644", "--- a/b.ts", "+++ b/b.ts", "@@ -1200,1 +1200,2 @@", " a", "+b", ""].join("\n");
  const [f] = parseUnifiedDiff(diff);
  const out = renderFileDiff(f, 50);
  assert.equal(visible(out[2]).slice(0, 12), "1200 1200   ");
  assert.equal(visible(out[3]).slice(0, 12), "     1201 + ");
  for (const l of out.slice(2)) assert.equal(visible(l).length, 50);
});

test("renderFileDiff carries grammar state across the lines of a hunk", () => {
  const [f] = parseUnifiedDiff(ONE_FILE("tpl.ts", "const s = `first", "second ${x}`;", "/* start", " still comment */ const y = 1;"));
  const out = renderFileDiff(f, 80);
  const second = out.find((l) => l.includes("second"));
  assert.ok(second);
  assert.ok(second.includes(fg(STRING, "second ")), second);
  const still = out.find((l) => l.includes("still"));
  assert.ok(still);
  assert.ok(still.includes(fg(COMMENT, " still comment */")), still);
  assert.ok(still.includes(fg(KEYWORD, "const")), still);
});

test("renderFileDiff tokenizes deletions against the old side and additions against the new side", () => {
  const diff = [
    "diff --git a/s.ts b/s.ts", "index 1..2 100644", "--- a/s.ts", "+++ b/s.ts",
    "@@ -1,2 +1,2 @@", " const s = `a", "-b`; const x = 1;", "+c`; const y = 2;", "",
  ].join("\n");
  const [f] = parseUnifiedDiff(diff);
  const out = renderFileDiff(f, 80);
  const del = out.find((l) => l.includes("b`"));
  const add = out.find((l) => l.includes("c`"));
  assert.ok(del && add);
  assert.ok(del.includes(fg(STRING, "b`")), del);
  assert.ok(del.includes(fg(KEYWORD, "const")), del);
  assert.ok(add.includes(fg(STRING, "c`")), add);
  assert.ok(add.includes(fg(KEYWORD, "const")), add);
});

test("renderFileDiff resets grammar state at hunk boundaries", () => {
  const diff = [
    "diff --git a/h.ts b/h.ts", "index 1..2 100644", "--- a/h.ts", "+++ b/h.ts",
    "@@ -1,1 +1,1 @@", "+/* opened here", "@@ -10,1 +10,1 @@", "+const z = 1;", "",
  ].join("\n");
  const [f] = parseUnifiedDiff(diff);
  const out = renderFileDiff(f, 80);
  const z = out.find((l) => visible(l).includes("z = "));
  assert.ok(z);
  assert.ok(z.includes(fg(KEYWORD, "const")), z);
  assert.ok(!z.includes(COMMENT), z);
});

test("renderFileDiff distinguishes functions, types, control flow, and comments", () => {
  const [f] = parseUnifiedDiff(ONE_FILE("k.ts", "function make(n: number): Foo { return call(n); } // note"));
  const line = renderFileDiff(f, 120).find((l) => l.includes("make"));
  assert.ok(line);
  assert.ok(line.includes(fg(FUNCTION, "make")), line);
  assert.ok(line.includes(fg(FUNCTION, "call")), line);
  assert.ok(line.includes(fg(TYPE, "number")), line);
  assert.ok(line.includes(fg(TYPE, "Foo")), line);
  assert.ok(line.includes(fg(CONTROL, "return")), line);
  assert.ok(line.includes(fg(VARIABLE, "n")), line);
  assert.ok(line.includes(fg(COMMENT, "// note")), line);
});

test("renderFileDiff leaves default-colored text untagged", () => {
  const [f] = parseUnifiedDiff(ONE_FILE("d.ts", "a = b;"));
  const line = renderFileDiff(f, 40).find((l) => visible(l).includes("a = b"));
  assert.ok(line);
  assert.ok(line.includes(" = "), line);
  assert.ok(!line.includes("#d4d4d4"), line);
});

test("renderFileDiff emits only blessed tags, no raw ANSI escapes", () => {
  const diff = [
    "diff --git a/w.ts b/w.ts",
    "index 1..2 100644",
    "--- a/w.ts",
    "+++ b/w.ts",
    "@@ -1,2 +1,2 @@",
    "+class Foo extends Bar { method(x: number) { return x; } }",
    "+function make(n: number): Foo { return new Foo(n); }",
    "diff --git a/p.html b/p.html",
    "index 1..2 100644",
    "--- a/p.html",
    "+++ b/p.html",
    "@@ -1,1 +1,1 @@",
    '+<div class="x"><em>hi</em></div>',
    "diff --git a/n.md b/n.md",
    "index 1..2 100644",
    "--- a/n.md",
    "+++ b/n.md",
    "@@ -1,1 +1,1 @@",
    "+some *bold* and _italic_ text",
    "",
  ].join("\n")
    + ONE_FILE("s.graphql", "type Query { user(id: ID!): User @deprecated }", 'query Q($id: ID!) { user(id: $id) { ...F } } # "c"')
    + ONE_FILE("m.tf", 'resource "aws_s3_bucket" "b" { bucket = "${var.name}-x" }', "locals { n = length(var.list) > 0 ? 1 : 0 } // c", "/* block */ enabled = false")
    + ONE_FILE("Dockerfile", "FROM node:20", "RUN pnpm install")
    + ONE_FILE("app.vue", "<template><div :class=\"x\">{{ y }}</div></template>", "<script setup lang=\"ts\">const y = 1;</script>");
  for (const f of parseUnifiedDiff(diff).concat(parseUnifiedDiff(TWO_FILE_DIFF))) {
    for (const line of renderFileDiff(f, 100)) {
      assert.ok(!line.includes(String.fromCharCode(27)), `ANSI escape leaked: ${JSON.stringify(line)}`);
      assert.ok(/^(\{[^{}]*\}|\{open\}|\{close\}|[^{}])*$/.test(line), `unbalanced brace: ${JSON.stringify(line)}`);
    }
  }
});

const ONE_FILE = (path: string, ...added: string[]) =>
  [`diff --git a/${path} b/${path}`, "index 1..2 100644", `--- a/${path}`, `+++ b/${path}`, `@@ -1,${added.length} +1,${added.length} @@`, ...added.map((l) => `+${l}`), ""].join("\n");

test("renderFileDiff highlights graphql schema files", () => {
  const [f] = parseUnifiedDiff(ONE_FILE("schema.graphql", "type Query {", "  user(id: ID!): User @deprecated", '  # comment "here"', "}"));
  const out = renderFileDiff(f, 80);
  const typeLine = out.find((l) => l.includes("Query"));
  assert.ok(typeLine);
  assert.ok(typeLine.includes(fg(KEYWORD, "type")), typeLine);
  assert.ok(typeLine.includes(fg(TYPE, "Query")), typeLine);
  const field = out.find((l) => l.includes("user"));
  assert.ok(field);
  assert.ok(field.includes(fg(TYPE, "User")), field);
  const comment = out.find((l) => l.includes("comment"));
  assert.ok(comment);
  assert.ok(comment.includes(COMMENT), comment);
  assert.ok(comment.includes('# comment "here"{/'), comment);
});

test("renderFileDiff highlights terraform files", () => {
  const [f] = parseUnifiedDiff(ONE_FILE("main.tf", 'resource "aws_s3_bucket" "b" {', "  bucket = var.name # trailing", "  count  = 3", "}"));
  const out = renderFileDiff(f, 80);
  const res = out.find((l) => l.includes("aws_s3_bucket"));
  assert.ok(res);
  assert.ok(res.includes(fg(TYPE, "resource")), res);
  assert.ok(res.includes(fg(CONSTANT, '"aws_s3_bucket"')), res);
  const attr = out.find((l) => l.includes("trailing"));
  assert.ok(attr);
  assert.ok(attr.includes(fg(COMMENT, "# trailing")), attr);
  const count = out.find((l) => l.includes("count"));
  assert.ok(count);
  assert.ok(count.includes(fg(NUMBER, "3")), count);
});

test("renderFileDiff escapes braces inside highlighted code lines", () => {
  const f: FileDiff = {
    path: "x.ts", oldPath: "x.ts", status: "modified", additions: 1, deletions: 0,
    lines: [{ kind: "hunk", text: "@@ -1,0 +1,1 @@" }, { kind: "add", text: "+const o = {};" }],
  };
  const [, , line] = renderFileDiff(f, 40);
  assert.ok(line.includes("{open}"), line);
  assert.ok(line.includes("{close}"), line);
});

test("renderFileDiff tints but does not tokenize unrecognized files", () => {
  const f: FileDiff = {
    path: "notes.zzz", oldPath: "notes.zzz", status: "modified", additions: 1, deletions: 1,
    lines: [
      { kind: "hunk", text: "@@ -1,1 +1,1 @@" },
      { kind: "add", text: "+hello there" },
      { kind: "del", text: "-goodbye" },
    ],
  };
  const out = renderFileDiff(f, 40);
  const add = out.find((l) => l.includes("hello there"));
  const del = out.find((l) => l.includes("goodbye"));
  assert.ok(add && del);
  assert.ok(add.startsWith(`{${ADD_BG}-bg}`), add);
  assert.ok(del.startsWith(`{${DEL_BG}-bg}`), del);
  const rest = add.replaceAll(`{${GUTTER}-fg}`, "").replaceAll(`{/${GUTTER}-fg}`, "").replaceAll(`{${ADD_BG}-bg}`, "").replaceAll(`{/${ADD_BG}-bg}`, "");
  assert.ok(!rest.includes("#"), rest);
  assert.ok(rest.includes("+{/green-fg} hello there"), rest);
});

test("renderFileDiff renders the no-newline marker dim without line numbers", () => {
  const diff = [
    "diff --git a/e.txt b/e.txt", "index 1..2 100644", "--- a/e.txt", "+++ b/e.txt",
    "@@ -1,1 +1,1 @@", "-old", "\\ No newline at end of file", "+new", "",
  ].join("\n");
  const [f] = parseUnifiedDiff(diff);
  const out = renderFileDiff(f, 40);
  const marker = out.find((l) => l.includes("No newline"));
  assert.ok(marker);
  assert.ok(marker.includes(`{${GUTTER}-fg}`), marker);
  assert.ok(!/\d/.test(visible(marker)), marker);
  const add = out.find((l) => visible(l).includes("+ new"));
  assert.ok(add);
  assert.equal(visible(add).slice(0, 10), "      1 + ");
});

test("renderFileDiff memoizes per file and width", () => {
  const [f] = parseUnifiedDiff(TWO_FILE_DIFF);
  assert.equal(renderFileDiff(f, 80), renderFileDiff(f, 80));
  assert.notEqual(renderFileDiff(f, 80), renderFileDiff(f, 60));
});

test("renderFileDiff shows the rename arrow and a binary stub", () => {
  const renamed: FileDiff = {
    path: "b.ts", oldPath: "a.ts", status: "renamed", additions: 0, deletions: 0, lines: [],
  };
  assert.ok(renderFileDiff(renamed, 40)[0].includes("a.ts -> b.ts"));
  const binary: FileDiff = {
    path: "logo.png", oldPath: "logo.png", status: "binary", additions: 0, deletions: 0, lines: [],
  };
  assert.ok(renderFileDiff(binary, 40).includes("{grey-fg}binary file, no text diff{/grey-fg}"));
});

test("importing the renderer clears blessed's stale 8-color cache so palette hexes map to their 256 index", () => {
  assert.equal(blessed.colors.match(ADD_BG), 22);
  assert.equal(blessed.colors.match(DEL_BG), 52);
  assert.equal(blessed.colors.match(GUTTER), 102);
});

const bare = (c: SideCell | null) => (c === null ? null : { no: c.no, kind: c.kind, text: c.text });

const PAIRING_DIFF = [
  "diff --git a/src/p.ts b/src/p.ts",
  "index 1..2 100644",
  "--- a/src/p.ts",
  "+++ b/src/p.ts",
  "@@ -10,4 +20,5 @@ fn",
  " keep",
  "-gone1",
  "-gone2",
  "+new1",
  "+new2",
  "+new3",
  " tail",
  "@@ -30,1 +41,1 @@",
  "-only del",
  "",
].join("\n");

test("sideBySideRows pairs del runs with the add run that follows and numbers both sides from the hunk header", () => {
  const [f] = parseUnifiedDiff(PAIRING_DIFF);
  const rows = sideBySideRows(f).map((r) => (r.kind === "hunk" ? r : { kind: r.kind, left: bare(r.left), right: bare(r.right) }));
  assert.deepEqual(rows, [
    { kind: "hunk", text: "@@ -10,4 +20,5 @@ fn" },
    { kind: "row", left: { no: 10, kind: "ctx", text: "keep" }, right: { no: 20, kind: "ctx", text: "keep" } },
    { kind: "row", left: { no: 11, kind: "del", text: "gone1" }, right: { no: 21, kind: "add", text: "new1" } },
    { kind: "row", left: { no: 12, kind: "del", text: "gone2" }, right: { no: 22, kind: "add", text: "new2" } },
    { kind: "row", left: null, right: { no: 23, kind: "add", text: "new3" } },
    { kind: "row", left: { no: 13, kind: "ctx", text: "tail" }, right: { no: 24, kind: "ctx", text: "tail" } },
    { kind: "hunk", text: "@@ -30,1 +41,1 @@" },
    { kind: "row", left: { no: 30, kind: "del", text: "only del" }, right: null },
  ]);
});

test("sideBySideRows starts a fresh pairing when a del follows an add", () => {
  const diff = ONE_FILE("q.ts").replace("@@ -1,0 +1,0 @@\n", "@@ -1,2 +1,2 @@\n-a\n+b\n-c\n+d\n");
  const [f] = parseUnifiedDiff(diff);
  const rows = sideBySideRows(f).filter((r) => r.kind === "row");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.left?.text, r.right?.text]), [["a", "b"], ["c", "d"]]);
});


test("renderSideBySide lays out old and new columns of equal width to the given width", () => {
  const [f] = parseUnifiedDiff(PAIRING_DIFF);
  const width = 60;
  const out = renderSideBySide(f, width);
  assert.equal(out[0], "{bold}src/p.ts{/bold}  {green-fg}+3{/green-fg} {red-fg}-3{/red-fg}");
  const rows = out.slice(1).filter((l) => !l.includes("@@"));
  for (const l of rows) assert.equal(visible(l).length, width, JSON.stringify(visible(l)));
  const paired = visible(rows[1]);
  assert.ok(paired.trimStart().startsWith("11 -gone1"), paired);
  assert.ok(paired.includes("│  21 +new1"), paired);
  const rightOnly = visible(rows[3]);
  assert.ok(rightOnly.trimStart().startsWith("│  23 +new3"), rightOnly);
});

test("renderSideBySide truncates long lines to the column instead of wrapping", () => {
  const long = "x".repeat(200);
  const [f] = parseUnifiedDiff(ONE_FILE("long.txt", long));
  const out = renderSideBySide(f, 40);
  const row = out.find((l) => l.includes("xxx"));
  assert.ok(row);
  assert.equal(visible(row).length, 40);
  assert.ok(!visible(row).includes("x".repeat(30)));
});

test("renderSideBySide tints each side by change kind and highlights code", () => {
  const [f] = parseUnifiedDiff(TWO_FILE_DIFF);
  const out = renderSideBySide(f, 80);
  const row = out.find((l) => l.includes("fresh"));
  assert.ok(row);
  const [left, right] = row.split("│");
  assert.ok(left.startsWith(`{${DEL_BG}-bg}`), left);
  assert.ok(left.includes("{red-fg}-{/red-fg}"), left);
  assert.ok(left.includes(fg(KEYWORD, "const")), left);
  assert.ok(right.includes(`{${ADD_BG}-bg}`), right);
  assert.ok(right.includes("{green-fg}+{/green-fg}"), right);
  assert.ok(right.includes(fg(CONSTANT, "fresh")), right);
  assert.ok(right.includes(`{${GUTTER}-fg}`), right);
  const ctx = out.find((l) => l.includes("keep"));
  assert.ok(ctx);
  assert.ok(!ctx.includes("-bg}"), ctx);
  for (const l of out) assert.ok(!l.includes(String.fromCharCode(27)));
});

test("renderSideBySide carries grammar state within a hunk side", () => {
  const [f] = parseUnifiedDiff(ONE_FILE("tpl.ts", "const s = `first", "second ${x}`;"));
  const row = renderSideBySide(f, 100).find((l) => l.includes("second"));
  assert.ok(row);
  assert.ok(row.includes(fg(STRING, "second ")), row);
});

test("renderSideBySide expands tabs so the columns stay aligned", () => {
  const [f] = parseUnifiedDiff(ONE_FILE("t.txt", "\tindented"));
  const out = renderSideBySide(f, 40);
  const row = out.find((l) => l.includes("indented"));
  assert.ok(row);
  assert.ok(!row.includes("\t"));
  assert.equal(visible(row).length, 40);
});

test("renderSideBySide memoizes per file and width", () => {
  const [f] = parseUnifiedDiff(TWO_FILE_DIFF);
  assert.equal(renderSideBySide(f, 80), renderSideBySide(f, 80));
  assert.notEqual(renderSideBySide(f, 80), renderSideBySide(f, 60));
});

test("renderSideBySide says so for binary files", () => {
  const diff = ["diff --git a/x.png b/x.png", "index 1..2 100644", "Binary files a/x.png and b/x.png differ", ""].join("\n");
  const [f] = parseUnifiedDiff(diff);
  assert.ok(renderSideBySide(f, 40).some((l) => l.includes("binary file")));
});

test("sideBySideRows drops the no-newline marker so the pair and the numbering hold", () => {
  const diff = [
    "diff --git a/e.txt b/e.txt", "index 1..2 100644", "--- a/e.txt", "+++ b/e.txt",
    "@@ -1,2 +1,2 @@", " top", "-old", "\\ No newline at end of file", "+new", "\\ No newline at end of file", "",
  ].join("\n");
  const [f] = parseUnifiedDiff(diff);
  const rows = sideBySideRows(f).filter((r) => r.kind === "row");
  assert.deepEqual(rows.map((r) => [r.left?.no, r.left?.text, r.right?.no, r.right?.text]), [
    [1, "top", 1, "top"],
    [2, "old", 2, "new"],
  ]);
});

test("renderSideBySide strips CRLF carriage returns so a row stays one line", () => {
  const [f] = parseUnifiedDiff(ONE_FILE("w.txt", "crlf line\r"));
  const row = renderSideBySide(f, 40).find((l) => l.includes("crlf"));
  assert.ok(row);
  assert.ok(!row.includes("\r"));
  assert.equal(visible(row).length, 40);
});

test("renderSideBySide pads and truncates by display columns, not code units", () => {
  const [f] = parseUnifiedDiff(ONE_FILE("u.txt", "标题 = 你好", "ok 😀 x", "宽".repeat(40)));
  const out = renderSideBySide(f, 40);
  const rows = out.filter((l) => l.includes("│"));
  assert.equal(rows.length, 3);
  for (const l of rows) assert.equal(strWidth(visible(l)), 40, JSON.stringify(visible(l)));
});

test("renderSideBySide tints add and del cells when no grammar applies", () => {
  const diff = ["diff --git a/n.zzz b/n.zzz", "index 1..2 100644", "--- a/n.zzz", "+++ b/n.zzz", "@@ -1,1 +1,1 @@", "-FROM a", "+FROM b", ""].join("\n");
  const [f] = parseUnifiedDiff(diff);
  const row = renderSideBySide(f, 60).find((l) => l.includes("FROM"));
  assert.ok(row);
  const [left, right] = row.split("│");
  assert.ok(left.startsWith(`{${DEL_BG}-bg}`), left);
  assert.ok(left.includes("FROM a"), left);
  assert.ok(right.includes(`{${ADD_BG}-bg}`), right);
  assert.ok(right.includes("FROM b"), right);
  assert.equal(visible(row).length, 60);
});

test("renderSideBySide keeps only the latest width in its cache", () => {
  const [f] = parseUnifiedDiff(TWO_FILE_DIFF);
  const a = renderSideBySide(f, 80);
  renderSideBySide(f, 60);
  assert.notEqual(renderSideBySide(f, 80), a, "an older width is re-rendered, not held");
});

test("warmHighlighter compiles the TypeScript grammars up front and renders stay consistent after it", () => {
  const [f] = parseUnifiedDiff(TWO_FILE_DIFF);
  const before = renderFileDiff(f, 70).slice();
  warmHighlighter();
  assert.deepEqual(renderFileDiff(f, 70), before);
});

test("renderSideBySide escapes braces in a hunk header once", () => {
  const diff = ["diff --git a/h.ts b/h.ts", "index 1..2 100644", "--- a/h.ts", "+++ b/h.ts", "@@ -1,1 +1,1 @@ export function foo() {", "+a", ""].join("\n");
  const [f] = parseUnifiedDiff(diff);
  const header = renderSideBySide(f, 60).find((l) => l.includes("@@"));
  assert.ok(header);
  assert.ok(header.includes("foo() {open}{/cyan-fg}") || header.includes("foo() {open} "), header);
  assert.ok(!header.includes("{open}open"), header);
  assert.equal(visible(header).length, 60);
});
