import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff } from "./review-diff.ts";

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
