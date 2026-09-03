import { test } from "node:test";
import assert from "node:assert/strict";
import { briefRows, drawable, flowView, nodeRows, scopeMap, wrapText } from "./arch-brief.ts";
import { UNMAPPED_ID, type ArchAnnotation, type ArchMap } from "./arch-map.ts";

// A hub (ent) with many inbound edges, the shape that made the full-map chart
// unreadable: scoping must not drag its untouched callers in behind it.
const MAP: ArchMap = {
  generatedAt: "2026-09-01T00:00:00Z",
  commit: "abc123",
  nodes: [
    { id: "svc", label: "domain services", role: "business logic", files: ["svc/**"] },
    { id: "ent", label: "ent schema", role: "entities and hooks", files: ["ent/**"] },
    { id: "workers", label: "river workers", role: "queued jobs", files: ["workers/**"] },
    { id: "resolvers", label: "resolvers", role: "graphql layer", files: ["resolvers/**"] },
    { id: "hooks", label: "webhooks", role: "inbound events", files: ["hooks/**"] },
    { id: "backfills", label: "backfills", role: "migrations", files: ["backfills/**"] },
  ],
  edges: [
    { from: "svc", to: "ent", carries: "derived records" },
    { from: "ent", to: "workers", carries: "jobs enqueued from hooks" },
    { from: "resolvers", to: "ent", carries: "ent queries" },
    { from: "hooks", to: "ent", carries: "remote upserts" },
    { from: "backfills", to: "ent", carries: "row rewrites" },
  ],
};

const ANN: ArchAnnotation = {
  flow: "the commission split moves off the deal and onto the offer",
  touched: [{ node: "svc", note: "split resolved per-offer" }],
  atRisk: [{ node: "workers", why: "job volume scales with deal edits", viaEdge: "ent -> workers" }],
  added: [],
};

const CHANGED = ["svc/commission.go", "svc/offer.go", "ent/deal.go"];

test("scopeMap keeps what the PR touches and what it endangers", () => {
  const sub = scopeMap(MAP, ANN, CHANGED);
  assert.deepEqual(sub.nodes.map((n) => n.id).sort(), ["ent", "svc", "workers"]);
});

test("scopeMap leaves a hub's untouched callers out", () => {
  const sub = scopeMap(MAP, ANN, CHANGED);
  const ids = sub.nodes.map((n) => n.id);
  for (const caller of ["resolvers", "hooks", "backfills"]) assert.ok(!ids.includes(caller));
  assert.deepEqual(sub.edges.map((e) => `${e.from}->${e.to}`).sort(), ["ent->workers", "svc->ent"]);
});

test("scopeMap keeps an edge only when both of its ends survive", () => {
  const sub = scopeMap(MAP, ANN, CHANGED);
  for (const e of sub.edges) {
    assert.ok(sub.nodes.some((n) => n.id === e.from));
    assert.ok(sub.nodes.some((n) => n.id === e.to));
  }
});

test("drawable draws a small scope and gives up on a big one", () => {
  assert.ok(drawable(scopeMap(MAP, ANN, CHANGED)));
  const wide: ArchMap = {
    ...MAP,
    nodes: Array.from({ length: 7 }, (_, i) => ({ id: `n${i}`, label: `n${i}`, role: "", files: [`n${i}/**`] })),
    edges: [],
  };
  assert.ok(!drawable(wide));
});

test("drawable skips a graph of one box, which shows nothing a list does not", () => {
  const lone: ArchMap = { ...MAP, nodes: [MAP.nodes[0]], edges: [] };
  assert.ok(!drawable(lone));
});

test("drawable gives up once the edges outnumber what routes cleanly", () => {
  const dense: ArchMap = {
    ...MAP,
    nodes: MAP.nodes.slice(0, 5),
    edges: Array.from({ length: 9 }, (_, i) => ({ from: "svc", to: `x${i}`, carries: "" })),
  };
  assert.ok(!drawable(dense));
});

test("wrapText breaks on spaces and hard breaks a word that cannot fit", () => {
  assert.deepEqual(wrapText("one two three", 9), ["one two", "three"]);
  assert.deepEqual(wrapText("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  assert.deepEqual(wrapText("", 10), []);
});

test("briefRows leads with the touched section, its role and its note", () => {
  const text = briefRows({ map: MAP, ann: ANN, changed: CHANGED, stale: 0, width: 80, selected: null })
    .map((r) => r.text)
    .join("\n");
  assert.ok(text.includes("TOUCHED"));
  assert.ok(text.includes("domain services"));
  assert.ok(text.includes("business logic"));
  assert.ok(text.includes("split resolved per-offer"));
  assert.ok(text.indexOf("TOUCHED") < text.indexOf("AT RISK"));
});

test("briefRows counts each touched node's own changed files", () => {
  const visible = briefRows({ map: MAP, ann: ANN, changed: CHANGED, stale: 0, width: 80, selected: null })
    .map((r) => r.text.replace(/\{[^{}]*\}/g, ""));
  assert.ok(visible.some((l) => l.endsWith("domain services   2 files")));
  assert.ok(visible.some((l) => l.endsWith("ent schema   1 file")));
});

test("briefRows spells the risk out as a labelled edge, which the chart cannot show", () => {
  const text = briefRows({ map: MAP, ann: ANN, changed: CHANGED, stale: 0, width: 120, selected: null })
    .map((r) => r.text)
    .join("\n");
  assert.ok(text.includes("jobs enqueued from hooks"));
  assert.ok(text.includes("job volume scales with deal edits"));
  assert.ok(text.includes("river workers"));
});

test("briefRows names the untouched rest without drawing it", () => {
  const text = briefRows({ map: MAP, ann: ANN, changed: CHANGED, stale: 0, width: 200, selected: null })
    .map((r) => r.text)
    .join("\n");
  assert.ok(text.includes("UNTOUCHED"));
  for (const label of ["resolvers", "webhooks", "backfills"]) assert.ok(text.includes(label));
});

test("briefRows leads with the stale warning when files are unmapped", () => {
  const rows = briefRows({ map: MAP, ann: ANN, changed: CHANGED, stale: 3, width: 80, selected: null });
  assert.ok(rows[0].text.includes("stale: 3 unmapped"));
  assert.ok(rows[0].text.includes("G regen"));
});

test("briefRows falls back to touched nodes only with no annotation", () => {
  const text = briefRows({ map: MAP, ann: null, changed: CHANGED, stale: 0, width: 80, selected: null })
    .map((r) => r.text)
    .join("\n");
  assert.ok(text.includes("no flow summary"));
  assert.ok(text.includes("domain services"));
  assert.ok(!text.includes("AT RISK"));
});

test("briefRows says so when the PR touches nothing the map claims", () => {
  const text = briefRows({ map: MAP, ann: ANN, changed: [], stale: 0, width: 80, selected: null })
    .map((r) => r.text)
    .join("\n");
  assert.ok(text.includes("no mapped node"));
});

test("briefRows escapes tags in model-written prose", () => {
  const ann: ArchAnnotation = { ...ANN, touched: [{ node: "svc", note: "guards {red-fg} input" }] };
  const text = briefRows({ map: MAP, ann, changed: CHANGED, stale: 0, width: 200, selected: null })
    .map((r) => r.text)
    .join("\n");
  assert.ok(text.includes("{open}red-fg{close}"));
});

test("nodeRows lists the selectable node ids in the order they are rendered", () => {
  const rows = briefRows({ map: MAP, ann: ANN, changed: CHANGED, stale: 0, width: 80, selected: null });
  assert.deepEqual(nodeRows(rows), ["svc", "ent", "workers"]);
});

test("flowView marks the selected node and reports the row it sits on", () => {
  const view = flowView({ map: MAP, ann: ANN, changed: CHANGED, stale: 0, width: 80, selected: "ent" });
  assert.ok(view.selectedRow > 0);
  assert.ok(view.rows[view.selectedRow].text.includes("{inverse}"));
  assert.equal(view.rows[view.selectedRow].node, "ent");
});

test("flowView draws the graph above the brief while the scope stays small", () => {
  const view = flowView({ map: MAP, ann: ANN, changed: CHANGED, stale: 0, width: 80, selected: null });
  const text = view.rows.map((r) => r.text).join("\n");
  assert.ok(text.includes("[ domain services ]"));
  assert.ok(text.indexOf("[ domain services ]") < text.indexOf("TOUCHED"));
});

test("flowView drops the graph rather than route a scope too big to read", () => {
  const wide: ArchMap = {
    ...MAP,
    nodes: Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, label: `node ${i}`, role: "", files: [`n${i}/**`] })),
    edges: [],
  };
  const many = Array.from({ length: 8 }, (_, i) => `n${i}/a.go`);
  const view = flowView({ map: wide, ann: null, changed: many, stale: 0, width: 80, selected: null });
  assert.ok(!view.rows.some((r) => r.text.includes("[ node 0 ]")));
  assert.ok(view.rows.some((r) => r.text.includes("TOUCHED")));
});

test("flowView reports no selected row when nothing is selected", () => {
  const view = flowView({ map: MAP, ann: ANN, changed: CHANGED, stale: 0, width: 80, selected: null });
  assert.equal(view.selectedRow, -1);
});

test("a node named as a risk edge's source is not also listed as untouched", () => {
  // ent is only idle here (nothing under ent/** changed), but it is still the
  // source the risk edge is spelled through, so listing it under the untouched
  // rest would have it appear twice saying opposite things.
  const ann: ArchAnnotation = { ...ANN, touched: [] };
  const rows = briefRows({ map: MAP, ann, changed: ["svc/a.go"], stale: 0, width: 200, selected: null });
  const rest = rows.slice(rows.findIndex((r) => r.text.includes("UNTOUCHED")));
  assert.ok(!rest.some((r) => r.text.includes("ent schema")));
  assert.ok(rest.some((r) => r.text.includes("resolvers")));
});

test("the empty touched section still leaves a gap before the risk section", () => {
  const rows = briefRows({ map: MAP, ann: ANN, changed: [], stale: 0, width: 80, selected: null });
  const gap = rows.findIndex((r) => r.text.includes("no mapped node")) + 1;
  assert.equal(rows[gap].text, "");
  assert.ok(rows[gap + 1].text.includes("AT RISK"));
});

test("a carries label too long for the row moves to its own line whole", () => {
  const long = "jobs enqueued from mutation hooks including sync, reconcile and notification fanout";
  const map: ArchMap = { ...MAP, edges: [{ from: "ent", to: "workers", carries: long }] };
  const rows = briefRows({ map, ann: ANN, changed: CHANGED, stale: 0, width: 60, selected: null });
  const visible = rows.map((r) => r.text.replace(/\{[^{}]*\}/g, ""));
  const head = visible.find((l) => l.includes("-->"))!;
  assert.ok(head.includes("ent schema  -->  river workers"), "the header degrades to a bare arrow");
  assert.ok(!head.includes("…"), "nothing is cut mid word");
  assert.ok(visible.some((l) => l.includes(`via: ${long}`.slice(0, 30))));
  assert.ok(visible.join(" ").includes("notification fanout"), "the whole label survives");
});

test("a carries label that fits stays inline between the two ends", () => {
  const rows = briefRows({ map: MAP, ann: ANN, changed: CHANGED, stale: 0, width: 120, selected: null });
  const visible = rows.map((r) => r.text.replace(/\{[^{}]*\}/g, ""));
  assert.ok(visible.some((l) => l.includes("--[ jobs enqueued from hooks ]-->")));
  assert.ok(!visible.some((l) => l.includes("via:")));
});

// normalizeAnnotation cross-checks neither list, so the model naming one node
// in both touched and atRisk reaches briefRows intact.
const BOTH: ArchAnnotation = {
  flow: "",
  touched: [{ node: "svc", note: "split moved" }, { node: "ent", note: "hook added" }],
  atRisk: [{ node: "ent", why: "reads the moved shape", viaEdge: "svc -> ent" }],
  added: [],
};

test("a node both touched and at risk gets one row, so j can never dead-end on it", () => {
  const rows = briefRows({ map: MAP, ann: BOTH, changed: CHANGED, stale: 0, width: 90, selected: null });
  const ids = nodeRows(rows);
  assert.deepEqual(ids, [...new Set(ids)], "no node id may appear on two rows");
  assert.deepEqual(ids, ["svc", "ent"]);
});

test("a touched node's risk reason rides on its own row rather than a second one", () => {
  const visible = briefRows({ map: MAP, ann: BOTH, changed: CHANGED, stale: 0, width: 90, selected: null })
    .map((r) => r.text.replace(/\{[^{}]*\}/g, ""));
  assert.ok(visible.some((l) => l.includes("reads the moved shape")));
  assert.ok(!visible.some((l) => l.includes("AT RISK")), "the only at risk node is already listed");
});

test("only one row is ever marked for the selected node", () => {
  const view = flowView({ map: MAP, ann: BOTH, changed: CHANGED, stale: 0, width: 90, selected: "ent" });
  const marked = view.rows.filter((r) => r.node !== null && r.text.includes("{inverse}"));
  assert.equal(marked.length, 1);
  assert.equal(view.rows[view.selectedRow].node, "ent");
});

test("two risks on one node both get their reason under a single row", () => {
  const ann: ArchAnnotation = {
    ...ANN,
    touched: [],
    atRisk: [
      { node: "workers", why: "job volume grows", viaEdge: "ent -> workers" },
      { node: "workers", why: "the payload shape moved", viaEdge: "svc -> ent" },
    ],
  };
  const rows = briefRows({ map: MAP, ann, changed: CHANGED, stale: 0, width: 90, selected: null });
  assert.deepEqual(nodeRows(rows).filter((id) => id === "workers"), ["workers"]);
  const visible = rows.map((r) => r.text.replace(/\{[^{}]*\}/g, "")).join("\n");
  assert.ok(visible.includes("job volume grows"));
  assert.ok(visible.includes("the payload shape moved"));
});

test("the risk heading stays away when every entry names a node the map lost", () => {
  const ann: ArchAnnotation = { ...ANN, atRisk: [{ node: "gone", why: "w", viaEdge: "svc -> gone" }] };
  const text = briefRows({ map: MAP, ann, changed: CHANGED, stale: 0, width: 90, selected: null })
    .map((r) => r.text)
    .join("\n");
  assert.ok(!text.includes("AT RISK"), "a bare heading with nothing under it says nothing");
});

test("the unmapped bucket counts its files once, in the label the merge gave it", () => {
  const map: ArchMap = {
    ...MAP,
    nodes: [...MAP.nodes, { id: UNMAPPED_ID, label: "unmapped (2)", role: "", files: ["odd/a.go", "odd/b.go"] }],
  };
  const visible = briefRows({
    map, ann: null, changed: ["odd/a.go", "odd/b.go"], stale: 2, width: 90, selected: null,
  }).map((r) => r.text.replace(/\{[^{}]*\}/g, ""));
  assert.ok(visible.some((l) => l.trim() === "unmapped (2)"));
  assert.ok(!visible.some((l) => l.includes("unmapped (2)   2 files")));
});
