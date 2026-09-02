import { test } from "node:test";
import assert from "node:assert/strict";
import {
  globToRegExp,
  mergedMap,
  nodeFiles,
  nodeForPath,
  nodeStates,
  parseArchMap,
  renderSet,
  unmappedPaths,
  UNMAPPED_ID,
  type ArchAnnotation,
  type ArchMap,
} from "./arch-map.ts";

const MAP: ArchMap = {
  generatedAt: "2026-09-01T00:00:00Z",
  commit: "abc123",
  nodes: [
    { id: "gh", label: "gh", role: "talks to GitHub", files: ["src/gh.ts"] },
    { id: "review", label: "review", role: "the overlay", files: ["src/review-*.ts", "src/tui-review.ts"] },
    { id: "watcher", label: "watcher", role: "polls state", files: ["src/watcher.ts"] },
  ],
  edges: [
    { from: "watcher", to: "gh", carries: "pr state fetch" },
    { from: "review", to: "gh", carries: "diff fetch" },
  ],
};

test("globToRegExp keeps * inside one path segment and lets ** cross them", () => {
  assert.ok(globToRegExp("src/*.ts").test("src/gh.ts"));
  assert.ok(!globToRegExp("src/*.ts").test("src/deep/gh.ts"));
  assert.ok(globToRegExp("src/**/*.ts").test("src/deep/gh.ts"));
  assert.ok(globToRegExp("src/**/*.ts").test("src/gh.ts"));
  assert.ok(!globToRegExp("src/gh.ts").test("src/ghXts"));
});

test("parseArchMap accepts a well formed map and rejects junk", () => {
  assert.deepEqual(parseArchMap(JSON.stringify(MAP)), MAP);
  assert.equal(parseArchMap("not json"), null);
  assert.equal(parseArchMap(JSON.stringify({ nodes: [] })), null);
});

test("parseArchMap drops nodes without files and edges naming unknown nodes", () => {
  const m = parseArchMap(JSON.stringify({
    nodes: [
      { id: "a", label: "a", role: "", files: ["src/a.ts"] },
      { id: "b", label: "b", role: "" },
    ],
    edges: [{ from: "a", to: "b", carries: "x" }, { from: "a", to: "a", carries: "self" }],
  }));
  assert.deepEqual(m?.nodes.map((n) => n.id), ["a"]);
  assert.deepEqual(m?.edges, [{ from: "a", to: "a", carries: "self" }]);
});

test("nodeForPath takes the first node whose globs match", () => {
  assert.equal(nodeForPath(MAP, "src/review-diff.ts")?.id, "review");
  assert.equal(nodeForPath(MAP, "src/gh.ts")?.id, "gh");
  assert.equal(nodeForPath(MAP, "scripts/onboard.ts"), null);
});

test("unmappedPaths lists only what no node claims", () => {
  assert.deepEqual(unmappedPaths(MAP, ["src/gh.ts", "scripts/onboard.ts", "README.md"]), [
    "scripts/onboard.ts",
    "README.md",
  ]);
});

test("nodeFiles returns the changed paths owned by one node", () => {
  assert.deepEqual(nodeFiles(MAP, "review", ["src/gh.ts", "src/review-diff.ts", "src/tui-review.ts"]), [
    "src/review-diff.ts",
    "src/tui-review.ts",
  ]);
});

const ANN: ArchAnnotation = {
  flow: "the review fetches a diff",
  touched: [{ node: "review", note: "adds the flow overlay" }],
  atRisk: [{ node: "watcher", why: "reads the state shape that moved", viaEdge: "gh->watcher" }],
  added: [{ id: "arch", label: "arch layout", files: ["src/arch-layout.ts"], edges: [{ to: "review", carries: "chart lines" }] }],
};

test("mergedMap appends annotation nodes, their edges, and an unmapped bucket", () => {
  const m = mergedMap(MAP, ANN, ["scripts/onboard.ts", "README.md"]);
  assert.deepEqual(m.nodes.map((n) => n.id), ["gh", "review", "watcher", "arch", "unmapped"]);
  assert.equal(m.nodes.find((n) => n.id === "unmapped")?.label, "unmapped (2)");
  assert.ok(m.edges.some((e) => e.from === "arch" && e.to === "review"));
});

test("mergedMap with no annotation and no unmapped paths is the map itself", () => {
  assert.deepEqual(mergedMap(MAP, null, []), MAP);
});

test("renderSet lets an added node claim its files before the bucket sweeps", () => {
  const { map, unmapped } = renderSet(MAP, ANN, ["src/arch-layout.ts", "scripts/onboard.ts"]);
  assert.deepEqual(unmapped, ["scripts/onboard.ts"]);
  assert.ok(!unmapped.includes("src/arch-layout.ts"));
  assert.equal(nodeForPath(map, "src/arch-layout.ts")?.id, "arch");
});

test("renderSet's bucket label matches the files nodeFiles can reach for it", () => {
  const changed = ["src/gh.ts", "scripts/onboard.ts", "README.md"];
  const { map, unmapped } = renderSet(MAP, ANN, changed);
  const bucket = map.nodes.find((n) => n.id === UNMAPPED_ID);
  assert.equal(bucket?.label, `unmapped (${unmapped.length})`);
  assert.deepEqual(nodeFiles(map, UNMAPPED_ID, changed), unmapped);
});

test("renderSet with nothing unmapped grows no bucket", () => {
  const { map, unmapped } = renderSet(MAP, null, ["src/gh.ts"]);
  assert.deepEqual(unmapped, []);
  assert.ok(!map.nodes.some((n) => n.id === UNMAPPED_ID));
});

test("nodeStates ranks added over touched over at risk", () => {
  const merged = mergedMap(MAP, ANN, ["scripts/onboard.ts"]);
  const st = nodeStates(merged, ANN, ["src/tui-review.ts", "src/arch-layout.ts", "scripts/onboard.ts"]);
  assert.equal(st.get("arch"), "added");
  assert.equal(st.get("review"), "touched");
  assert.equal(st.get("watcher"), "at-risk");
  assert.equal(st.get("gh"), "idle");
  assert.equal(st.get("unmapped"), "unmapped");
});

test("nodeStates without an annotation still lights touched nodes", () => {
  const st = nodeStates(MAP, null, ["src/gh.ts"]);
  assert.equal(st.get("gh"), "touched");
  assert.equal(st.get("review"), "idle");
});
