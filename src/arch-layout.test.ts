import { test } from "node:test";
import assert from "node:assert/strict";
import { breakCycles, dedupeEdges, orderRanks, rankNodes } from "./arch-layout.ts";
import type { ArchEdge } from "./arch-map.ts";

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
