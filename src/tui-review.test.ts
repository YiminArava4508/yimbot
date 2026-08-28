import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diffPaneLines,
  flattenFiles,
  groupOf,
  nextUnviewed,
  placeholderGroups,
  planLines,
  reviewFooterHint,
  reviewHeader,
  reviewLayout,
} from "./tui-review.ts";
import type { FileDiff } from "./review-diff.ts";

const GROUPS = [
  { title: "core", context: "the change itself", files: ["src/a.ts", "src/b.ts"] },
  { title: "tests", context: "", files: ["src/a.test.ts"] },
];

test("flattenFiles preserves group order then file order", () => {
  assert.deepEqual(flattenFiles(GROUPS), ["src/a.ts", "src/b.ts", "src/a.test.ts"]);
});

test("groupOf finds the owning group and null for unknown paths", () => {
  assert.equal(groupOf(GROUPS, "src/a.test.ts")?.title, "tests");
  assert.equal(groupOf(GROUPS, "nope.ts"), null);
});

test("nextUnviewed wraps past the end and stays put when everything is viewed", () => {
  const files = ["a", "b", "c"];
  assert.equal(nextUnviewed(files, new Set(["b"]), 0), 2);
  assert.equal(nextUnviewed(files, new Set(["b", "c"]), 1), 0);
  assert.equal(nextUnviewed(files, new Set(files), 1), 1);
});

test("placeholderGroups puts every path under one organizing group", () => {
  const g = placeholderGroups(["a.ts", "b.ts"]);
  assert.equal(g.groups.length, 1);
  assert.ok(g.groups[0].title.includes("organizing"));
  assert.deepEqual(g.groups[0].files, ["a.ts", "b.ts"]);
});

test("planLines renders bold headers, viewed checks, and an inverse selected line", () => {
  const { lines, selectedLine } = planLines(GROUPS, new Set(["src/b.ts"]), "src/a.ts");
  assert.equal(lines[0], "{bold}core{/bold}");
  assert.equal(lines[1], "{inverse}   src/a.ts{/inverse}");
  assert.equal(lines[2], " {green-fg}✓{/green-fg} src/b.ts");
  assert.equal(lines[3], "{bold}tests{/bold}");
  assert.equal(selectedLine, 1);
});

test("planLines returns selectedLine -1 when nothing is selected", () => {
  assert.equal(planLines(GROUPS, new Set(), null).selectedLine, -1);
});

test("diffPaneLines leads with the group context, dim, then the rendered diff", () => {
  const fd: FileDiff = {
    path: "src/a.ts", oldPath: "src/a.ts", status: "modified", additions: 0, deletions: 0, lines: [],
  };
  const out = diffPaneLines(GROUPS[0], fd);
  assert.equal(out[0], "{grey-fg}the change itself{/grey-fg}");
  assert.equal(out[1], "");
  assert.ok(out[2].includes("src/a.ts"));
});

test("diffPaneLines shows a loading stub without a diff", () => {
  assert.ok(diffPaneLines(null, null)[0].includes("loading"));
});

test("reviewHeader shows PR, title and progress", () => {
  assert.equal(reviewHeader(42, "add widget", 3, 9), "PR #42  add widget  |  3/9 viewed");
});

test("reviewFooterHint offers y only when all viewed and draft", () => {
  const base = { total: 3, allViewed: false, isDraft: true, diffFocused: false };
  assert.ok(!reviewFooterHint(base).includes("y mark PR ready"));
  assert.ok(reviewFooterHint({ ...base, allViewed: true }).includes("y mark PR ready"));
  assert.ok(reviewFooterHint({ ...base, allViewed: true, isDraft: false }).includes("review complete"));
  assert.ok(reviewFooterHint({ ...base, total: 0 }).includes("loading"));
});

test("reviewLayout pins the panes: plan left 30%, diff filling the rest", () => {
  const l = reviewLayout();
  assert.equal(l.plan.width, "30%");
  assert.equal(l.diff.left, "30%");
  assert.equal(l.header.height, 1);
  assert.equal(l.footer.bottom, 0);
});
