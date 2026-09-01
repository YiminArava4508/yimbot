// src/arch-layout.ts
// Sugiyama-lite for a terminal: break cycles, rank by longest path, order each
// rank by barycenter, place one-line boxes, route orthogonal edges onto a char
// grid. Every pass is pure and exported so the hard parts test on their own.
import type { ArchEdge } from "./arch-map.ts";

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
