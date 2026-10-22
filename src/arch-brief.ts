// src/arch-brief.ts
// The flow view's content: the PR's slice of the architecture map, rendered as
// a short graph over a written brief. The full map is deliberately not drawn.
// At twenty nodes the routed channels stack into walls of pipes that no reader
// can trace, and the untouched majority of them says nothing about the PR
// anyway. Scoping to what the change reaches also makes room for the three
// fields a box chart can never show: a node's role, an edge's carries, and the
// annotation's reason a downstream node is at risk.
import { BODY_TAG, CATEGORY_TAGS, chip, DIM_TAG, layoutGraph, STATE_TAGS } from "./arch-layout.ts";
import {
  CATEGORIES, nodeFiles, nodeStates, UNMAPPED_ID,
  type ArchAnnotation, type ArchMap, type Category, type NodeState,
} from "./arch-map.ts";
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
  context = false,
): ArchMap {
  const states = precomputed ?? nodeStates(map, ann, changed);
  const keep = new Set(map.nodes.filter((n) => states.get(n.id) !== "idle").map((n) => n.id));
  const active = new Set(keep);
  if (context) {
    for (const e of map.edges) {
      if (active.has(e.from)) keep.add(e.to);
      if (active.has(e.to)) keep.add(e.from);
    }
  }
  return {
    ...map,
    nodes: map.nodes.filter((n) => keep.has(n.id)),
    edges: map.edges.filter((e) => keep.has(e.from) && keep.has(e.to) && (active.has(e.from) || active.has(e.to))),
  };
}

const MAX_NODES = 6;
const MAX_EDGES = 8;

// Past these counts the routing stops being traceable, so the graph is skipped
// and the brief stands alone. A single box is skipped from the other end: it
// draws nothing the node's own line in the brief does not already say.
export function drawable(sub: ArchMap, states?: Map<string, NodeState>): boolean {
  const shown = states ? sub.nodes.filter((n) => states.get(n.id) !== "idle").length : sub.nodes.length;
  return shown >= 2 && shown <= MAX_NODES && sub.edges.length <= MAX_EDGES;
}

type BriefInput = {
  map: ArchMap;
  ann: ArchAnnotation | null;
  changed: string[];
  stale: number;
  width: number;
  selected: string | null;
  title?: string;
  // Drawn between the header and the entries, so the summary reads first.
  graph?: BriefRow[];
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

const LABEL_WIDTH = 9;
const MIN_LABELED_ROOM = 10;

// A dim label in a fixed column with the text wrapped under itself, so a long
// note never slides back under the label.
function labeled(label: string, text: string, width: number, textTag: string = BODY_TAG): BriefRow[] {
  const room = width - DETAIL_INDENT.length - LABEL_WIDTH;
  if (room < MIN_LABELED_ROOM) {
    const labelRow = { text: `${DETAIL_INDENT}{${DIM_TAG}}${label}{/${DIM_TAG}}`, node: null };
    return [labelRow, ...detail(text, width, textTag)];
  }
  return wrapText(text, room).map((line, i) => ({
    text: DETAIL_INDENT
      + (i === 0 ? `{${DIM_TAG}}${label.padEnd(LABEL_WIDTH)}{/${DIM_TAG}}` : " ".repeat(LABEL_WIDTH))
      + `{${textTag}}${escapeTags(line)}{/${textTag}}`,
    node: null,
  }));
}

function plainRow(text: string, width: number, tag: string): BriefRow[] {
  return wrapText(text, width).map((line) => ({ text: `{${tag}}${escapeTags(line)}{/${tag}}`, node: null }));
}

function entryCategory(ann: ArchAnnotation | null, id: string, state: NodeState): Category | null {
  const t = ann?.touched.find((x) => x.node === id);
  if (t) return t.category ?? "behavior";
  const r = ann?.atRisk.find((x) => x.node === id);
  if (r) return r.category ?? "risk";
  if (state === "added") return "new";
  return null;
}

function entryTitle(ann: ArchAnnotation | null, id: string): string {
  return ann?.touched.find((x) => x.node === id)?.title ?? ann?.atRisk.find((x) => x.node === id)?.title ?? "";
}

function categoryCounts(ann: ArchAnnotation): string {
  const all = [...ann.touched.map((t) => t.category ?? "behavior"), ...ann.atRisk.map((r) => r.category ?? "risk")];
  return CATEGORIES.filter((c) => all.includes(c))
    .map((c) => `{${CATEGORY_TAGS[c]}}${all.filter((x) => x === c).length} ${c}{/${CATEGORY_TAGS[c]}}`)
    .join("  ");
}

// count < 0 leaves the tally off, which is how the unmapped bucket is drawn:
// mergedMap already put its file count in the label it built.
function nodeHeader(label: string, state: NodeState, count: number, selected: boolean, category: Category | null = null): string {
  const [open, close] = STATE_TAGS[state];
  const tally = count < 0 ? "" : `   ${count} file${count === 1 ? "" : "s"}`;
  const body = escapeTags(label) + tally;
  const tag = category ? `${chip(category)} ` : "";
  return NODE_INDENT + (selected ? "{inverse}" : "") + tag + open + body + close + (selected ? "{/inverse}" : "");
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
    if (carries !== "") out.push(...labeled("consumes", carries, s.width));
    if (r.why !== "") out.push(...labeled("risk", r.why, s.width, "red-fg"));
    return out;
  };

  if (s.stale > 0) {
    const files = `${s.stale}`;
    rows.push({ text: `{yellow-fg}stale: ${files} unmapped   G regen{/yellow-fg}`, node: null });
  }
  if (s.title) rows.push({ text: `{bold}${escapeTags(s.title)}{/bold}`, node: null });
  if (s.ann === null) {
    rows.push({ text: `{${DIM_TAG}}no flow summary, touched nodes only{/${DIM_TAG}}`, node: null });
  } else {
    if (s.ann.summary) {
      rows.push(...plainRow(s.ann.summary.what, s.width, BODY_TAG));
      if (s.ann.summary.why !== "") rows.push(...plainRow(`why ${s.ann.summary.why}`, s.width, DIM_TAG));
    }
    if (s.ann.flow !== "") rows.push(...plainRow(s.ann.flow, s.width, s.ann.summary ? DIM_TAG : BODY_TAG));
    const counts = categoryCounts(s.ann);
    if (counts !== "") rows.push({ text: counts, node: null });
  }
  if (rows.length > 0) rows.push(spacer());
  if (s.graph) rows.push(...s.graph);

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
    const state = states.get(n.id) ?? "idle";
    const title = entryTitle(s.ann, n.id);
    const text = nodeHeader(title || n.label, state, count, n.id === s.selected, entryCategory(s.ann, n.id, state));
    rows.push({ text, node: n.id });
    const roleLine = title ? [n.label, n.role].filter((x) => x !== "").join(" · ") : n.role;
    if (roleLine !== "") rows.push(...detail(roleLine, s.width, DIM_TAG));
    if (bucket) rows.push(...detail("no node claims these files", s.width, DIM_TAG));
    const note = s.ann?.touched.find((t) => t.node === n.id)?.note;
    if (note) rows.push(...labeled("changes", note, s.width));
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
    const title = entryTitle(s.ann, id);
    const category = entryCategory(s.ann, id, states.get(id) ?? "at-risk");
    const chipRoom = category ? category.length + 3 : 0;
    const head = source && entries.length === 1 && title === ""
      ? riskHeader(source.label, target.label, edge?.carries ?? "", s.width - chipRoom)
      : { text: escapeTags(title || target.label), via: "" };
    const [open, close] = STATE_TAGS[states.get(id) ?? "at-risk"];
    const mark = id === s.selected;
    riskRows.push({
      text: NODE_INDENT + (mark ? "{inverse}" : "") + (category ? `${chip(category)} ` : "") + open + head.text + close
        + (mark ? "{/inverse}" : ""),
      node: id,
    });
    // A header that spelled the edge out leaves only the reason; otherwise
    // each entry gets its own consumes and risk lines.
    if (head.text.includes("-->")) {
      if (head.via !== "") riskRows.push(...labeled("consumes", head.via, s.width));
      if (first.why !== "") riskRows.push(...labeled("risk", first.why, s.width, "red-fg"));
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
  const states = s.states ?? nodeStates(s.map, s.ann, s.changed);
  const withContext = scopeMap(s.map, s.ann, s.changed, states, true);
  const sub = drawable(withContext, states) ? withContext : scopeMap(s.map, s.ann, s.changed, states);
  let graph: BriefRow[] | undefined;
  if (drawable(sub, states)) {
    graph = [...layoutGraph(sub, states, s.width, s.selected).lines.map((text) => ({ text, node: null })), spacer()];
  }
  const rows = briefRows({ ...s, states, graph });
  const selectedRow = s.selected === null ? -1 : rows.findIndex((r) => r.node === s.selected);
  return { rows, selectedRow, nodes: nodeRows(rows) };
}
