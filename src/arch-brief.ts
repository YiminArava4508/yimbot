// src/arch-brief.ts
// The flow view's content: the PR's slice of the architecture map, rendered as
// a short graph over a written brief. The full map is deliberately not drawn.
// At twenty nodes the routed channels stack into walls of pipes that no reader
// can trace, and the untouched majority of them says nothing about the PR
// anyway. Scoping to what the change reaches also makes room for the three
// fields a box chart can never show: a node's role, an edge's carries, and the
// annotation's reason a downstream node is at risk.
import { DIM_TAG, layoutGraph, STATE_TAGS } from "./arch-layout.ts";
import { nodeFiles, nodeStates, UNMAPPED_ID, type ArchAnnotation, type ArchMap, type NodeState } from "./arch-map.ts";
import { escapeTags } from "./review-diff.ts";

// A row the operator can land on carries its node id; spacers and prose carry
// null, so j/k skips them the way the plan pane skips its group headers.
export type BriefRow = { text: string; node: string | null };

const NODE_INDENT = "  ";
const DETAIL_INDENT = "      ";

// Greedy word wrap on raw text, before tags go on: escapeTags' {open}/{close}
// each render as one column, so measuring the escaped form would wrap short.
export function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return [];
  const w = Math.max(1, width);
  const out: string[] = [];
  let line = "";
  for (const word of words) {
    if (line !== "" && line.length + 1 + word.length > w) {
      out.push(line);
      line = "";
    }
    // The flush above always fires first for a word this long, so the line is
    // empty here and the hard break starts at the left margin.
    if (word.length > w) {
      let rest = word;
      while (rest.length > w) {
        out.push(rest.slice(0, w));
        rest = rest.slice(w);
      }
      line = rest;
      continue;
    }
    line = line === "" ? word : `${line} ${word}`;
  }
  if (line !== "") out.push(line);
  return out;
}

// The PR's slice: every node the change touches, adds, leaves unmapped or puts
// at risk, and the edges between two survivors. Dropping the idle nodes is what
// makes the graph readable, and it matters most at a hub: ent-model in a real
// map has eight inbound edges, seven of them from callers this PR never went
// near, and keeping them buys nothing but crossings.
export function scopeMap(
  map: ArchMap,
  ann: ArchAnnotation | null,
  changed: string[],
  precomputed?: Map<string, NodeState>,
): ArchMap {
  const states = precomputed ?? nodeStates(map, ann, changed);
  const keep = new Set(map.nodes.filter((n) => states.get(n.id) !== "idle").map((n) => n.id));
  return {
    ...map,
    nodes: map.nodes.filter((n) => keep.has(n.id)),
    edges: map.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
  };
}

const MAX_NODES = 6;
const MAX_EDGES = 8;

// Past these counts the routing stops being traceable, so the graph is skipped
// and the brief stands alone. A single box is skipped from the other end: it
// draws nothing the node's own line in the brief does not already say.
export function drawable(sub: ArchMap): boolean {
  return sub.nodes.length >= 2 && sub.nodes.length <= MAX_NODES && sub.edges.length <= MAX_EDGES;
}

type BriefInput = {
  map: ArchMap;
  ann: ArchAnnotation | null;
  changed: string[];
  stale: number;
  width: number;
  selected: string | null;
  // Precomputed by flowView and threaded through, so one paint runs the node
  // globs over the changed paths once rather than once per reader.
  states?: Map<string, NodeState>;
};

const spacer = (): BriefRow => ({ text: "", node: null });

function heading(text: string): BriefRow {
  return { text: `{bold}${text}{/bold}`, node: null };
}

function detail(text: string, width: number, tag: string | null = null): BriefRow[] {
  const room = width - DETAIL_INDENT.length;
  return wrapText(text, room).map((line) => ({
    text: DETAIL_INDENT + (tag ? `{${tag}}${escapeTags(line)}{/${tag}}` : escapeTags(line)),
    node: null,
  }));
}

// count < 0 leaves the tally off, which is how the unmapped bucket is drawn:
// mergedMap already put its file count in the label it built.
function nodeHeader(label: string, state: NodeState, count: number, selected: boolean): string {
  const [open, close] = STATE_TAGS[state];
  const tally = count < 0 ? "" : `   ${count} file${count === 1 ? "" : "s"}`;
  const body = escapeTags(label) + tally;
  return NODE_INDENT + (selected ? "{inverse}" : "") + open + body + close + (selected ? "{/inverse}" : "");
}

// The carries label rides inline between the two ends while it fits, because
// that is where it reads as the thing the edge hands over. Once it does not,
// the header degrades to a bare arrow and the caller gives the label its own
// wrapped line: the row the selection is anchored to must not wrap, and a
// label cut mid-word reads as a rendering fault rather than as an ellipsis.
const BRACKETS = "  --[  ]-->  ".length;

function riskHeader(from: string, to: string, carries: string, width: number): { text: string; via: string } {
  const room = width - NODE_INDENT.length - from.length - to.length - BRACKETS;
  if (carries !== "" && carries.length <= room) {
    return { text: `${escapeTags(from)}  --[ ${escapeTags(carries)} ]-->  ${escapeTags(to)}`, via: "" };
  }
  return { text: `${escapeTags(from)}  -->  ${escapeTags(to)}`, via: carries };
}

export function briefRows(s: BriefInput): BriefRow[] {
  const states = s.states ?? nodeStates(s.map, s.ann, s.changed);
  const byId = new Map(s.map.nodes.map((n) => [n.id, n]));
  const rows: BriefRow[] = [];

  // Grouped by node, and only for nodes the map still has: the annotation is
  // cached per head SHA and a regenerate can drop the node it named. Grouping
  // is what keeps one node to one row, which moveNode's indexOf depends on --
  // a node listed twice resolves to the first row every time, and j stops
  // dead there. The model is free to name the same node in both touched and
  // atRisk, and normalizeAnnotation cross-checks neither list.
  const risks = new Map<string, ArchAnnotation["atRisk"]>();
  for (const r of s.ann?.atRisk ?? []) {
    if (!byId.has(r.node)) continue;
    risks.set(r.node, [...(risks.get(r.node) ?? []), r]);
  }

  // The edge spelled out: what it hands over, then why that endangers the
  // target. Shared so a risk reads the same whether it hangs off the touched
  // section or its own.
  const riskDetail = (r: ArchAnnotation["atRisk"][number]): BriefRow[] => {
    const [fromId] = r.viaEdge.split("->").map((x) => x.trim());
    const carries = s.map.edges.find((e) => e.from === fromId && e.to === r.node)?.carries ?? "";
    const out: BriefRow[] = [];
    if (carries !== "") out.push(...detail(`via: ${carries}`, s.width, DIM_TAG));
    if (r.why !== "") out.push(...detail(`! ${r.why}`, s.width, "red-fg"));
    return out;
  };

  if (s.stale > 0) {
    const files = `${s.stale}`;
    rows.push({ text: `{yellow-fg}stale: ${files} unmapped   G regen{/yellow-fg}`, node: null });
  }
  if (s.ann === null) {
    rows.push({ text: `{${DIM_TAG}}no flow summary, touched nodes only{/${DIM_TAG}}`, node: null });
  } else if (s.ann.flow !== "") {
    for (const line of wrapText(s.ann.flow, s.width)) {
      rows.push({ text: `{${DIM_TAG}}${escapeTags(line)}{/${DIM_TAG}}`, node: null });
    }
  }
  if (rows.length > 0) rows.push(spacer());

  const inSection = (want: NodeState[]): ArchMap["nodes"] =>
    s.map.nodes.filter((n) => want.includes(states.get(n.id) ?? "idle"));

  rows.push(heading("TOUCHED"));
  const touched = inSection(["touched", "added", "unmapped"]);
  if (touched.length === 0) {
    rows.push({ text: `${NODE_INDENT}{${DIM_TAG}}no mapped node touched{/${DIM_TAG}}`, node: null });
    rows.push(spacer());
  }
  for (const n of touched) {
    const bucket = n.id === UNMAPPED_ID;
    const count = bucket ? -1 : nodeFiles(s.map, n.id, s.changed).length;
    const text = nodeHeader(n.label, states.get(n.id) ?? "idle", count, n.id === s.selected);
    rows.push({ text, node: n.id });
    if (n.role !== "") rows.push(...detail(n.role, s.width, DIM_TAG));
    if (bucket) rows.push(...detail("no node claims these files", s.width, DIM_TAG));
    const note = s.ann?.touched.find((t) => t.node === n.id)?.note;
    if (note) rows.push(...detail(`~ ${note}`, s.width));
    // Touched wins over at-risk in nodeStates, so a node in both lists lands
    // here; its reason comes along rather than earning a duplicate row below.
    for (const r of risks.get(n.id) ?? []) rows.push(...riskDetail(r));
    rows.push(spacer());
  }

  // Only the nodes not already spoken for above, so no id is rendered twice.
  const listed = new Set(touched.map((n) => n.id));
  // The node a risk edge is spelled through, which is idle whenever the PR
  // reached its target without touching it. It is named here, so the rest
  // roster leaves it out rather than list it as untouched too.
  const named = new Set<string>();
  const riskRows: BriefRow[] = [];
  for (const [id, entries] of risks) {
    for (const r of entries) named.add(r.viaEdge.split("->")[0].trim());
    if (listed.has(id)) continue;
    const target = byId.get(id) as ArchMap["nodes"][number];
    const first = entries[0];
    const source = byId.get(first.viaEdge.split("->")[0].trim());
    const edge = s.map.edges.find((e) => e.from === source?.id && e.to === id);
    const head = source && entries.length === 1
      ? riskHeader(source.label, target.label, edge?.carries ?? "", s.width)
      : { text: escapeTags(target.label), via: "" };
    const [open, close] = STATE_TAGS[states.get(id) ?? "at-risk"];
    const mark = id === s.selected;
    riskRows.push({
      text: NODE_INDENT + (mark ? "{inverse}" : "") + open + head.text + close + (mark ? "{/inverse}" : ""),
      node: id,
    });
    // One edge is already spelled out by the header, so only its reason is
    // left; several share a bare header and each gets its own via and reason.
    if (entries.length === 1) {
      if (head.via !== "") riskRows.push(...detail(`via: ${head.via}`, s.width, DIM_TAG));
      if (first.why !== "") riskRows.push(...detail(`! ${first.why}`, s.width, "red-fg"));
    } else {
      for (const r of entries) riskRows.push(...riskDetail(r));
    }
    riskRows.push(spacer());
  }
  // Built before the heading goes on: every entry can name a node the map no
  // longer has, and a bare heading with nothing under it says nothing.
  if (riskRows.length > 0) {
    rows.push(heading("AT RISK"));
    rows.push(...riskRows);
  }

  const rest = inSection(["idle"]).filter((n) => !named.has(n.id));
  if (rest.length > 0) {
    rows.push({ text: `{${DIM_TAG}}UNTOUCHED{/${DIM_TAG}}`, node: null });
    const room = s.width - NODE_INDENT.length;
    for (const line of wrapText(rest.map((n) => n.label).join(" · "), room)) {
      rows.push({ text: `${NODE_INDENT}{${DIM_TAG}}${escapeTags(line)}{/${DIM_TAG}}`, node: null });
    }
  }
  return rows;
}

export function nodeRows(rows: BriefRow[]): string[] {
  return rows.filter((r) => r.node !== null).map((r) => r.node as string);
}

// The whole flow pane in one pass: the scoped graph when it can be read, then
// the brief. selectedRow is what the shell scrolls to, so the row the operator
// picked stays on screen as they walk down a brief taller than the pane.
export function flowView(s: BriefInput): { rows: BriefRow[]; selectedRow: number; nodes: string[] } {
  const rows: BriefRow[] = [];
  const states = s.states ?? nodeStates(s.map, s.ann, s.changed);
  const sub = scopeMap(s.map, s.ann, s.changed, states);
  if (drawable(sub)) {
    for (const line of layoutGraph(sub, states, s.width, s.selected).lines) {
      rows.push({ text: line, node: null });
    }
    rows.push(spacer());
  }
  rows.push(...briefRows({ ...s, states }));
  const selectedRow = s.selected === null ? -1 : rows.findIndex((r) => r.node === s.selected);
  return { rows, selectedRow, nodes: nodeRows(rows) };
}
