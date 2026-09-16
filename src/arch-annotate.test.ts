import { test } from "node:test";
import assert from "node:assert/strict";
import { annotationPrompt, fetchAnnotation, normalizeAnnotation, parseAnnotation } from "./arch-annotate.ts";
import type { ArchMap } from "./arch-map.ts";
import type { FileStat } from "./review-groups.ts";

const MAP: ArchMap = {
  generatedAt: "", commit: "",
  nodes: [
    { id: "gh", label: "gh", role: "talks to GitHub", files: ["src/gh.ts"] },
    { id: "review", label: "review", role: "the overlay", files: ["src/tui-review.ts"] },
  ],
  edges: [{ from: "review", to: "gh", carries: "diff fetch" }],
};

const FILES: FileStat[] = [
  { path: "src/gh.ts", additions: 12, deletions: 3, status: "modified", hunks: ["export function prDiff("] },
  { path: "src/new.ts", additions: 40, deletions: 0, status: "added", hunks: [] },
];

test("annotationPrompt names every node, every edge and every changed file", () => {
  const p = annotationPrompt(MAP, { number: 7, title: "detach launches", body: "why" }, FILES);
  assert.ok(p.includes("gh"));
  assert.ok(p.includes("review -> gh (diff fetch)"));
  assert.ok(p.includes("src/gh.ts"));
  assert.ok(p.includes("src/new.ts"));
  assert.ok(p.includes("export function prDiff("));
  assert.ok(p.includes("#7"));
  assert.ok(p.includes("detach launches"));
});

test("parseAnnotation reads JSON out of surrounding prose", () => {
  const out = `sure, here you go\n${JSON.stringify({
    flow: "review pulls a diff from gh",
    touched: [{ node: "gh", note: "the fetch signature moved" }],
    atRisk: [{ node: "review", why: "calls prDiff", viaEdge: "review->gh" }],
    added: [],
  })}\nhope that helps`;
  const a = parseAnnotation(out, MAP);
  assert.equal(a?.flow, "review pulls a diff from gh");
  assert.deepEqual(a?.touched, [{ node: "gh", note: "the fetch signature moved" }]);
  assert.equal(a?.atRisk[0].node, "review");
});

test("parseAnnotation drops entries naming nodes the map does not have", () => {
  const a = parseAnnotation(JSON.stringify({
    flow: "f",
    touched: [{ node: "ghost", note: "n" }, { node: "gh", note: "real" }],
    atRisk: [{ node: "ghost", why: "w", viaEdge: "x" }],
    added: [],
  }), MAP);
  assert.deepEqual(a?.touched.map((t) => t.node), ["gh"]);
  assert.deepEqual(a?.atRisk, []);
});

test("parseAnnotation keeps added nodes and their edges into known targets", () => {
  const a = parseAnnotation(JSON.stringify({
    flow: "f",
    touched: [],
    atRisk: [{ node: "fresh", why: "brand new", viaEdge: "fresh->gh" }],
    added: [{ id: "fresh", label: "fresh thing", files: ["src/new.ts"], edges: [{ to: "gh", carries: "calls" }, { to: "ghost", carries: "nope" }] }],
  }), MAP);
  assert.equal(a?.added[0].id, "fresh");
  assert.deepEqual(a?.added[0].edges, [{ to: "gh", carries: "calls" }]);
  assert.equal(a?.atRisk[0].node, "fresh");
});

test("parseAnnotation returns null for junk and for an empty annotation", () => {
  assert.equal(parseAnnotation("no json here", MAP), null);
  assert.equal(parseAnnotation(JSON.stringify({ flow: "", touched: [], atRisk: [], added: [] }), MAP), null);
});

test("normalizeAnnotation validates a cached object the same way", () => {
  const cached = { flow: "f", touched: [{ node: "gh", note: "n" }], atRisk: [], added: [] };
  assert.equal(normalizeAnnotation(cached, MAP)?.flow, "f");
  assert.equal(normalizeAnnotation({ flow: 3 }, MAP), null);
  assert.equal(normalizeAnnotation(null, MAP), null);
});

test("fetchAnnotation returns null when the runner throws", async () => {
  const a = await fetchAnnotation(async () => { throw new Error("no claude"); }, MAP, { number: 1, title: "t", body: "" }, FILES);
  assert.equal(a, null);
});

test("fetchAnnotation passes the built prompt to the runner", async () => {
  let seen = "";
  const a = await fetchAnnotation(async (p) => {
    seen = p;
    return JSON.stringify({ flow: "f", touched: [{ node: "gh", note: "n" }], atRisk: [], added: [] });
  }, MAP, { number: 1, title: "t", body: "" }, FILES);
  assert.ok(seen.includes("src/gh.ts"));
  assert.equal(a?.flow, "f");
});
