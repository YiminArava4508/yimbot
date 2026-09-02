import { test } from "node:test";
import assert from "node:assert/strict";
import {
  breakCycles,
  dedupeEdges,
  displayLabel,
  layoutGraph,
  orderRanks,
  placeNodes,
  rankNodes,
  renderGrid,
  serializeGrid,
  type NodeBox,
} from "./arch-layout.ts";
import type { ArchEdge, ArchMap, NodeState } from "./arch-map.ts";

const e = (from: string, to: string): ArchEdge => ({ from, to, carries: "" });

test("dedupeEdges collapses repeated pairs and keeps the first carries text", () => {
  const out = dedupeEdges([
    { from: "a", to: "b", carries: "first" },
    { from: "a", to: "b", carries: "second" },
    e("b", "c"),
  ]);
  assert.deepEqual(out, [{ from: "a", to: "b", carries: "first" }, { from: "b", to: "c", carries: "" }]);
});

test("breakCycles leaves an acyclic graph untouched", () => {
  const { acyclic, back } = breakCycles(["a", "b", "c"], [e("a", "b"), e("b", "c")]);
  assert.deepEqual(back, []);
  assert.equal(acyclic.length, 2);
});

test("breakCycles pulls the edge that closes a loop", () => {
  const { acyclic, back } = breakCycles(["a", "b", "c"], [e("a", "b"), e("b", "c"), e("c", "a")]);
  assert.deepEqual(back.map((b) => `${b.from}->${b.to}`), ["c->a"]);
  assert.equal(acyclic.length, 2);
});

test("breakCycles treats a self edge as a back edge and terminates", () => {
  const { acyclic, back } = breakCycles(["a"], [e("a", "a")]);
  assert.deepEqual(back.map((b) => `${b.from}->${b.to}`), ["a->a"]);
  assert.deepEqual(acyclic, []);
});

test("breakCycles reaches a component with no source node", () => {
  const { back } = breakCycles(["a", "b"], [e("a", "b"), e("b", "a")]);
  assert.equal(back.length, 1);
});

test("rankNodes gives every node its longest path from a source", () => {
  const rank = rankNodes(["a", "b", "c", "d"], [e("a", "b"), e("b", "d"), e("a", "d"), e("a", "c")]);
  assert.equal(rank.get("a"), 0);
  assert.equal(rank.get("b"), 1);
  assert.equal(rank.get("c"), 1);
  assert.equal(rank.get("d"), 2);
});

test("rankNodes puts an isolated node at rank 0", () => {
  assert.equal(rankNodes(["a", "lonely"], []).get("lonely"), 0);
});

test("orderRanks buckets nodes by rank and keeps every node exactly once", () => {
  const nodes = ["a", "b", "c", "d"];
  const edges = [e("a", "b"), e("a", "c"), e("b", "d")];
  const rows = orderRanks(nodes, rankNodes(nodes, edges), edges);
  assert.deepEqual(rows[0], ["a"]);
  assert.deepEqual([...rows.flat()].sort(), nodes);
  assert.equal(rows.length, 3);
});

test("orderRanks pulls a node next to its neighbour instead of leaving it crossed", () => {
  // a -> y and b -> x: the alphabetical order x,y in rank 1 crosses both edges.
  const nodes = ["a", "b", "x", "y"];
  const edges = [e("a", "y"), e("b", "x")];
  const rank = new Map([["a", 0], ["b", 0], ["x", 1], ["y", 1]]);
  const rows = orderRanks(nodes, rank, edges);
  assert.deepEqual(rows[0], ["a", "b"]);
  assert.deepEqual(rows[1], ["y", "x"]);
});

test("displayLabel appends the marker its state earns", () => {
  assert.equal(displayLabel("gh", "idle"), "gh");
  assert.equal(displayLabel("gh", "touched"), "gh");
  assert.equal(displayLabel("gh", "at-risk"), "gh (!)");
  assert.equal(displayLabel("gh", "added"), "gh NEW");
});

test("placeNodes centers each rank and never overlaps two boxes", () => {
  const labels = new Map([["a", "aa"], ["b", "bb"], ["c", "cc"]]);
  const { boxes, height } = placeNodes([["a"], ["b", "c"]], labels, 40);
  const a = boxes.find((x) => x.id === "a") as { row: number; colStart: number; colEnd: number };
  assert.equal(a.row, 0);
  assert.equal(a.colEnd - a.colStart + 1, 6);
  const rank1 = boxes.filter((x) => x.row === 3).sort((x, y) => x.colStart - y.colStart);
  assert.equal(rank1.length, 2);
  assert.ok(rank1[0].colEnd < rank1[1].colStart);
  assert.equal(height, 5);
});

test("placeNodes leaves a gap row under the bottom rank for an exit stub", () => {
  const { boxes, height } = placeNodes([["a"], ["b"]], new Map([["a", "aa"], ["b", "bb"]]), 30);
  const last = Math.max(...boxes.map((b) => b.row));
  assert.ok(height > last + 1, "the row below the last box row must exist");
});

test("placeNodes wraps a rank wider than the pane onto a second row", () => {
  const ids = ["a", "b", "c", "d"];
  const labels = new Map(ids.map((i) => [i, i.repeat(6)]));
  const { boxes } = placeNodes([ids], labels, 30);
  assert.ok(new Set(boxes.map((b) => b.row)).size > 1);
  assert.ok(boxes.every((b) => b.colEnd < 30));
});

test("placeNodes truncates a label too wide for the pane", () => {
  const { boxes } = placeNodes([["a"]], new Map([["a", "x".repeat(80)]]), 20);
  assert.ok(boxes[0].colEnd < 20);
});

test("renderGrid draws a box as [ label ] on its own row", () => {
  const labels = new Map([["a", "gh"]]);
  const { boxes, height } = placeNodes([["a"]], labels, 20);
  const grid = renderGrid(boxes, labels, [], 20, height);
  assert.ok(grid[0].join("").includes("[ gh ]"));
});

test("renderGrid lands an arrow head directly above the target box", () => {
  const labels = new Map([["a", "aa"], ["b", "bb"]]);
  const { boxes, height } = placeNodes([["a"], ["b"]], labels, 30);
  const grid = renderGrid(boxes, labels, [{ from: "a", to: "b", carries: "" }], 30, height);
  const b = boxes.find((x) => x.id === "b") as { row: number; colStart: number; colEnd: number };
  assert.equal(grid[b.row - 1][Math.floor((b.colStart + b.colEnd) / 2)], "v");
});

test("renderGrid routes an edge that skips a rank without erasing the box between", () => {
  const labels = new Map([["a", "aa"], ["b", "bb"], ["c", "cc"]]);
  const { boxes, height } = placeNodes([["a"], ["b"], ["c"]], labels, 40);
  const grid = renderGrid(boxes, labels, [{ from: "a", to: "c", carries: "" }], 40, height);
  const b = boxes.find((x) => x.id === "b") as { row: number };
  assert.ok(grid[b.row].join("").includes("[ bb ]"));
  const c = boxes.find((x) => x.id === "c") as { row: number; colStart: number; colEnd: number };
  assert.equal(grid[c.row - 1][Math.floor((c.colStart + c.colEnd) / 2)], "v");
});

test("renderGrid clips a routed run rather than overwrite a box that fills the channel", () => {
  const labels = new Map([["a", "a"], ["b", "b".repeat(10)], ["c", "c"]]);
  const { boxes, height } = placeNodes([["a"], ["b"], ["c"]], labels, 14);
  const grid = renderGrid(boxes, labels, [{ from: "a", to: "c", carries: "" }], 14, height);
  const b = boxes.find((x) => x.id === "b") as { row: number };
  assert.equal(grid[b.row].join(""), `[ ${"b".repeat(10)} ]`);
});

test("renderGrid points a back edge up into its target", () => {
  const labels = new Map([["a", "aa"], ["b", "bb"]]);
  const { boxes, height } = placeNodes([["a"], ["b"]], labels, 30);
  const grid = renderGrid(boxes, labels, [{ from: "b", to: "a", carries: "" }], 30, height);
  const a = boxes.find((x) => x.id === "a") as { row: number };
  assert.ok(grid[a.row + 1].includes("^"));
});

test("renderGrid never writes outside the given width", () => {
  const labels = new Map([["a", "aa"], ["b", "bb"]]);
  const { boxes, height } = placeNodes([["a"], ["b"]], labels, 24);
  const grid = renderGrid(boxes, labels, [{ from: "a", to: "b", carries: "" }], 24, height);
  assert.ok(grid.every((row) => row.length === 24));
});

test("serializeGrid wraps each box in its state's color and leaves routing plain", () => {
  const labels = new Map([["a", "gh"]]);
  const states = new Map<string, NodeState>([["a", "touched"]]);
  const { boxes, height } = placeNodes([["a"]], labels, 20);
  const out = serializeGrid(renderGrid(boxes, labels, [], 20, height), boxes, states);
  assert.ok(out[0].includes("{bold}{white-fg}[ gh ]{/white-fg}{/bold}"));
});

test("serializeGrid escapes braces in a label so tags cannot be forged", () => {
  const labels = new Map([["a", "a{b}"]]);
  const states = new Map<string, NodeState>([["a", "idle"]]);
  const { boxes, height } = placeNodes([["a"]], labels, 20);
  const out = serializeGrid(renderGrid(boxes, labels, [], 20, height), boxes, states);
  assert.ok(out[0].includes("{open}"));
  assert.ok(!out[0].includes("[ a{b} ]"));
});

const MAP2: ArchMap = {
  generatedAt: "", commit: "",
  nodes: [
    { id: "board", label: "board", role: "", files: ["src/tui.ts"] },
    { id: "review", label: "review", role: "", files: ["src/tui-review.ts"] },
    { id: "gh", label: "gh", role: "", files: ["src/gh.ts"] },
  ],
  edges: [
    { from: "board", to: "review", carries: "opens" },
    { from: "review", to: "gh", carries: "diff" },
    { from: "gh", to: "board", carries: "pr rows" },
  ],
};

test("layoutGraph renders every node and returns boxes in reading order", () => {
  const states = new Map<string, NodeState>([["board", "touched"], ["review", "idle"], ["gh", "at-risk"]]);
  const { lines, boxes } = layoutGraph(MAP2, states, 60);
  const text = lines.join("\n");
  assert.ok(text.includes("board"));
  assert.ok(text.includes("review"));
  assert.ok(text.includes("gh (!)"));
  const sorted = [...boxes].sort((a, b) => a.row - b.row || a.colStart - b.colStart);
  assert.deepEqual(boxes.map((b) => b.id), sorted.map((b) => b.id));
});

// layoutGraph's passes down to the char grid, which layoutGraph itself does not
// hand back; the endpoint check below needs the raw cells.
function gridFor(map: ArchMap, width: number): { grid: string[][]; boxes: NodeBox[] } {
  const ids = map.nodes.map((n) => n.id);
  const labels = new Map(map.nodes.map((n) => [n.id, n.label]));
  const edges = dedupeEdges(map.edges).filter((x) => x.from !== x.to);
  const { acyclic } = breakCycles(ids, edges);
  const rows = orderRanks(ids, rankNodes(ids, acyclic), acyclic);
  const { boxes, height } = placeNodes(rows, labels, width);
  return { grid: renderGrid(boxes, labels, edges, width, height), boxes };
}

test("every edge terminates on both endpoint boxes, back edges included", () => {
  const { grid, boxes } = gridFor(MAP2, 60);
  const byId = new Map(boxes.map((b) => [b.id, b]));
  for (const edge of MAP2.edges) {
    const from = byId.get(edge.from) as NodeBox;
    const to = byId.get(edge.to) as NodeBox;
    const name = `${edge.from}->${edge.to}`;
    const cf = Math.floor((from.colStart + from.colEnd) / 2);
    const ct = Math.floor((to.colStart + to.colEnd) / 2);
    const stub = grid[from.row + 1]?.[cf];
    assert.ok(stub !== undefined && stub !== " ", `${name} leaves no stub under ${edge.from}`);
    const forward = to.row > from.row;
    const head = grid[forward ? to.row - 1 : to.row + 1]?.[ct];
    assert.equal(head, forward ? "v" : "^", `${name} lands no head on ${edge.to}`);
  }
});

test("layoutGraph survives a map with no edges at all", () => {
  const map: ArchMap = { generatedAt: "", commit: "", nodes: MAP2.nodes, edges: [] };
  const states = new Map<string, NodeState>(map.nodes.map((n) => [n.id, "idle" as NodeState]));
  assert.ok(layoutGraph(map, states, 60).lines.join("\n").includes("board"));
});
