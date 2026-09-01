// src/arch-layout.ts
// Sugiyama-lite for a terminal: break cycles, rank by longest path, order each
// rank by barycenter, place one-line boxes, route orthogonal edges onto a char
// grid. Every pass is pure and exported so the hard parts test on their own.
import type { ArchEdge, ArchMap, NodeState } from "./arch-map.ts";
import { escapeTags } from "./review-diff.ts";

const key = (e: ArchEdge): string => `${e.from}->${e.to}`;

export function dedupeEdges(edges: ArchEdge[]): ArchEdge[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    if (seen.has(key(e))) return false;
    seen.add(key(e));
    return true;
  });
}

// DFS colouring: an edge into a node still on the stack closes a loop. Those
// come out for ranking and go back in for drawing, so a cycle in the map costs
// a routed back edge, never a hang.
export function breakCycles(nodes: string[], edges: ArchEdge[]): { acyclic: ArchEdge[]; back: ArchEdge[] } {
  const out = new Map<string, ArchEdge[]>(nodes.map((n) => [n, []]));
  for (const e of edges) out.get(e.from)?.push(e);
  const color = new Map<string, 0 | 1 | 2>(nodes.map((n) => [n, 0]));
  const back = new Set<string>();
  const visit = (id: string): void => {
    color.set(id, 1);
    for (const e of out.get(id) ?? []) {
      const c = color.get(e.to) ?? 2;
      if (c === 1) back.add(key(e));
      else if (c === 0) visit(e.to);
    }
    color.set(id, 2);
  };
  const indeg = new Map<string, number>(nodes.map((n) => [n, 0]));
  for (const e of edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  for (const n of nodes) if (indeg.get(n) === 0 && color.get(n) === 0) visit(n);
  for (const n of nodes) if (color.get(n) === 0) visit(n);
  return {
    acyclic: edges.filter((e) => !back.has(key(e))),
    back: edges.filter((e) => back.has(key(e))),
  };
}

export function rankNodes(nodes: string[], acyclic: ArchEdge[]): Map<string, number> {
  const indeg = new Map<string, number>(nodes.map((n) => [n, 0]));
  const out = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const e of acyclic) {
    if (!indeg.has(e.to) || !out.has(e.from)) continue;
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    out.get(e.from)?.push(e.to);
  }
  const rank = new Map<string, number>(nodes.map((n) => [n, 0]));
  const queue = nodes.filter((n) => indeg.get(n) === 0);
  while (queue.length > 0) {
    const n = queue.shift() as string;
    for (const m of out.get(n) ?? []) {
      rank.set(m, Math.max(rank.get(m) ?? 0, (rank.get(n) ?? 0) + 1));
      indeg.set(m, (indeg.get(m) ?? 0) - 1);
      if (indeg.get(m) === 0) queue.push(m);
    }
  }
  return rank;
}

// Two sweeps, down then up: each rank sorts by the mean position of its
// neighbours in the reference rank, and a node with no neighbour there keeps
// the slot it had. Cheap, and it clears the crossings a terminal chart shows.
export function orderRanks(nodes: string[], rank: Map<string, number>, edges: ArchEdge[]): string[][] {
  const maxRank = nodes.reduce((m, n) => Math.max(m, rank.get(n) ?? 0), 0);
  const rows: string[][] = [];
  for (let r = 0; r <= maxRank; r++) rows.push(nodes.filter((n) => (rank.get(n) ?? 0) === r));
  const positions = (): Map<string, number> => {
    const m = new Map<string, number>();
    for (const row of rows) row.forEach((id, i) => m.set(id, i));
    return m;
  };
  const sweep = (dir: "down" | "up"): void => {
    const pos = positions();
    const order = dir === "down" ? rows.map((_, i) => i) : rows.map((_, i) => rows.length - 1 - i);
    for (const r of order) {
      const bary = (id: string): number => {
        const ns = edges
          .filter((x) => (dir === "down" ? x.to === id : x.from === id))
          .map((x) => pos.get(dir === "down" ? x.from : x.to))
          .filter((p): p is number => p !== undefined);
        if (ns.length === 0) return pos.get(id) ?? 0;
        return ns.reduce((a, b) => a + b, 0) / ns.length;
      };
      rows[r] = [...rows[r]].sort((a, b) => bary(a) - bary(b) || a.localeCompare(b));
    }
  };
  sweep("down");
  sweep("up");
  return rows;
}

export type NodeBox = { id: string; row: number; colStart: number; colEnd: number };

const GAP = 2;
const PAD = 2;

export function displayLabel(label: string, state: NodeState): string {
  if (state === "at-risk") return `${label} (!)`;
  if (state === "added") return `${label} NEW`;
  return label;
}

export function placeNodes(
  rows: string[][],
  labels: Map<string, string>,
  width: number,
): { boxes: NodeBox[]; height: number } {
  const boxes: NodeBox[] = [];
  const cap = Math.max(1, width - 4);
  const widthOf = (id: string): number => Math.min(width, (labels.get(id) ?? id).slice(0, cap).length + 4);
  let row = 0;
  for (const rank of rows) {
    if (rank.length === 0) continue;
    const subRows: string[][] = [];
    let cur: string[] = [];
    let used = 0;
    for (const id of rank) {
      const w = widthOf(id);
      const add = cur.length === 0 ? w : w + PAD;
      if (cur.length > 0 && used + add > width) {
        subRows.push(cur);
        cur = [id];
        used = w;
      } else {
        cur.push(id);
        used += add;
      }
    }
    if (cur.length > 0) subRows.push(cur);
    for (const sub of subRows) {
      const total = sub.reduce((n, id) => n + widthOf(id), 0) + PAD * (sub.length - 1);
      let col = Math.max(0, Math.floor((width - total) / 2));
      for (const id of sub) {
        const w = widthOf(id);
        boxes.push({ id, row, colStart: col, colEnd: col + w - 1 });
        col += w + PAD;
      }
      row += 1 + GAP;
    }
  }
  return { boxes, height: Math.max(1, row - GAP) };
}

const center = (b: NodeBox): number => Math.floor((b.colStart + b.colEnd) / 2);

// A run crossing a channel reads as +; a head glyph always wins over a mere
// routing mark (a straight edge routes and terminates on the same cell when
// its source and target share a column), but one head never bumps another.
// Routing only ever touches gap rows, so a box cannot be clobbered either.
function put(grid: string[][], row: number, col: number, ch: string): void {
  if (row < 0 || row >= grid.length || col < 0 || col >= grid[row].length) return;
  const cur = grid[row][col];
  if (cur === ch) return;
  if (ch === "v" || ch === "^") {
    if (cur === "v" || cur === "^") return;
    grid[row][col] = ch;
    return;
  }
  if ((cur === "-" && ch === "|") || (cur === "|" && ch === "-")) {
    grid[row][col] = "+";
    return;
  }
  if (cur === "v" || cur === "^" || cur === "+") return;
  grid[row][col] = ch;
}

function hRun(grid: string[][], row: number, from: number, to: number): void {
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  for (let c = lo; c <= hi; c++) put(grid, row, c, "-");
}

function vRun(grid: string[][], col: number, from: number, to: number): void {
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  for (let r = lo; r <= hi; r++) put(grid, r, col, "|");
}

// A column with no box in the rows the channel passes through. Scans outward
// from `near` so a channel stays close to its edge; when nothing is free it
// falls back to `near`, where put() marks the crossings.
function channelCol(boxes: NodeBox[], fromRow: number, toRow: number, near: number, width: number): number {
  const [lo, hi] = fromRow <= toRow ? [fromRow, toRow] : [toRow, fromRow];
  const blocked = (col: number): boolean =>
    boxes.some((b) => b.row >= lo && b.row <= hi && col >= b.colStart - 1 && col <= b.colEnd + 1);
  for (let d = 0; d < width; d++) {
    for (const col of [near + d, near - d]) {
      if (col >= 0 && col < width && !blocked(col)) return col;
    }
  }
  return Math.max(0, Math.min(width - 1, near));
}

export function renderGrid(
  boxes: NodeBox[],
  labels: Map<string, string>,
  edges: ArchEdge[],
  width: number,
  height: number,
): string[][] {
  const grid: string[][] = Array.from({ length: height }, () => Array.from({ length: width }, () => " "));
  const byId = new Map(boxes.map((b) => [b.id, b]));
  for (const b of boxes) {
    const text = `[ ${(labels.get(b.id) ?? b.id).slice(0, Math.max(1, width - 4))} ]`;
    for (let i = 0; i < text.length && b.colStart + i < width; i++) grid[b.row][b.colStart + i] = text[i];
  }
  for (const e of edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) continue;
    const cf = center(from);
    const ct = center(to);
    if (to.row > from.row) {
      // Forward. The run leaves on the row below the source and the head lands
      // on the row above the target, so both ends touch their box.
      const exit = from.row + 1;
      const entry = to.row - 1;
      if (entry === exit) {
        hRun(grid, exit, cf, ct);
        put(grid, exit, cf, cf === ct ? "|" : "+");
      } else {
        const ch = channelCol(boxes, exit, entry, cf, width);
        hRun(grid, exit, cf, ch);
        vRun(grid, ch, exit, entry);
        hRun(grid, entry, ch, ct);
      }
      put(grid, entry, ct, "v");
      continue;
    }
    // Same rank or backwards: leave below the source, run a free channel, come
    // back in from underneath the target.
    const exit = from.row + 1;
    const entry = to.row + 1;
    const ch = channelCol(boxes, Math.min(exit, entry), Math.max(exit, entry), Math.max(cf, ct) + 3, width);
    hRun(grid, exit, cf, ch);
    vRun(grid, ch, exit, entry);
    hRun(grid, entry, ch, ct);
    put(grid, entry, ct, "^");
  }
  return grid;
}

const STATE_TAGS: Record<NodeState, [string, string]> = {
  touched: ["{bold}{white-fg}", "{/white-fg}{/bold}"],
  "at-risk": ["{red-fg}", "{/red-fg}"],
  added: ["{green-fg}", "{/green-fg}"],
  unmapped: ["{yellow-fg}", "{/yellow-fg}"],
  idle: ["{grey-fg}", "{/grey-fg}"],
};

// Tags go on last, over a finished grid: routing never reasons about markup,
// and a tag can never end up inside a box or split by a wrap.
export function serializeGrid(
  grid: string[][],
  boxes: NodeBox[],
  states: Map<string, NodeState>,
): string[] {
  const byRow = new Map<number, NodeBox[]>();
  for (const b of boxes) byRow.set(b.row, [...(byRow.get(b.row) ?? []), b]);
  return grid.map((cells, row) => {
    const here = (byRow.get(row) ?? []).sort((a, b) => a.colStart - b.colStart);
    if (here.length === 0) return escapeTags(cells.join("").replace(/\s+$/, ""));
    let out = "";
    let col = 0;
    for (const b of here) {
      out += escapeTags(cells.slice(col, b.colStart).join(""));
      const [open, close] = STATE_TAGS[states.get(b.id) ?? "idle"];
      out += open + escapeTags(cells.slice(b.colStart, b.colEnd + 1).join("")) + close;
      col = b.colEnd + 1;
    }
    return out + escapeTags(cells.slice(col).join("").replace(/\s+$/, ""));
  });
}

export function layoutGraph(
  map: ArchMap,
  states: Map<string, NodeState>,
  width: number,
): { lines: string[]; boxes: NodeBox[] } {
  const w = Math.max(12, width);
  const ids = map.nodes.map((n) => n.id);
  const labels = new Map(map.nodes.map((n) => [n.id, displayLabel(n.label, states.get(n.id) ?? "idle")]));
  // A self edge carries no reading order, and routing one would cost a gap row
  // for nothing.
  const edges = dedupeEdges(map.edges).filter((e) => e.from !== e.to);
  const { acyclic } = breakCycles(ids, edges);
  const rank = rankNodes(ids, acyclic);
  const rows = orderRanks(ids, rank, acyclic);
  const { boxes, height } = placeNodes(rows, labels, w);
  const grid = renderGrid(boxes, labels, edges, w, height);
  const ordered = [...boxes].sort((a, b) => a.row - b.row || a.colStart - b.colStart);
  return { lines: serializeGrid(grid, boxes, states), boxes: ordered };
}
