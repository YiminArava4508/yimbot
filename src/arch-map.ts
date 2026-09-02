// src/arch-map.ts
// The architecture map's data model: a committed skeleton of the reviewed
// codebase (nodes with file globs, edges with what they carry), the per-PR
// annotation laid over it, and the derived per-node state the chart renders.
import { join } from "node:path";

export type ArchNode = { id: string; label: string; role: string; files: string[] };
export type ArchEdge = { from: string; to: string; carries: string };
export type ArchMap = { generatedAt: string; commit: string; nodes: ArchNode[]; edges: ArchEdge[] };

export type ArchAnnotation = {
  flow: string;
  touched: { node: string; note: string }[];
  atRisk: { node: string; why: string; viaEdge: string }[];
  added: { id: string; label: string; files: string[]; edges: { to: string; carries: string }[] }[];
};

export type NodeState = "added" | "touched" | "at-risk" | "unmapped" | "idle";

export const UNMAPPED_ID = "unmapped";

export function archMapPath(codebase: string): string {
  return join(codebase, "docs", "architecture-map.json");
}

// nodeForPath runs every glob against every changed path on every paint, so the
// compiled form is kept rather than rebuilt tens of thousands of times.
const globCache = new Map<string, RegExp>();

// Two placeholders only: * inside a segment, ** across them. A scanner rather
// than chained replaces so no sentinel can collide with the glob's own text.
export function globToRegExp(glob: string): RegExp {
  const hit = globCache.get(glob);
  if (hit) return hit;
  let body = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        body += "(?:.*/)?";
        i += 2;
      } else {
        body += ".*";
        i += 1;
      }
      continue;
    }
    if (c === "*") {
      body += "[^/]*";
      continue;
    }
    body += /[.+^${}()|[\]\\?]/.test(c) ? `\\${c}` : c;
  }
  const re = new RegExp(`^${body}$`);
  globCache.set(glob, re);
  return re;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function parseArchMap(raw: string): ArchMap | null {
  try {
    return archMapFrom(JSON.parse(raw));
  } catch {
    return null;
  }
}

// The shape check on its own, for the generator: it reads the map out of model
// stdout through extractJsonObject rather than from a file of plain JSON.
export function archMapFrom(obj: unknown): ArchMap | null {
  if (obj === null || typeof obj !== "object") return null;
  const o = obj as { generatedAt?: unknown; commit?: unknown; nodes?: unknown; edges?: unknown };
  if (!Array.isArray(o.nodes)) return null;
  const nodes: ArchNode[] = [];
  for (const entry of o.nodes) {
    const n = entry as { id?: unknown; label?: unknown; role?: unknown; files?: unknown };
    if (typeof n.id !== "string" || n.id === "") continue;
    const files = stringList(n.files);
    if (files.length === 0) continue;
    if (nodes.some((x) => x.id === n.id)) continue;
    nodes.push({ id: n.id, label: str(n.label) || n.id, role: str(n.role), files });
  }
  if (nodes.length === 0) return null;
  const known = new Set(nodes.map((n) => n.id));
  const edges: ArchEdge[] = [];
  for (const entry of Array.isArray(o.edges) ? o.edges : []) {
    const e = entry as { from?: unknown; to?: unknown; carries?: unknown };
    if (typeof e.from !== "string" || typeof e.to !== "string") continue;
    if (!known.has(e.from) || !known.has(e.to)) continue;
    edges.push({ from: e.from, to: e.to, carries: str(e.carries) });
  }
  return { generatedAt: str(o.generatedAt), commit: str(o.commit), nodes, edges };
}

export function nodeForPath(map: ArchMap, path: string): ArchNode | null {
  return map.nodes.find((n) => n.files.some((g) => globToRegExp(g).test(path))) ?? null;
}

export function unmappedPaths(map: ArchMap, paths: string[]): string[] {
  return paths.filter((p) => nodeForPath(map, p) === null);
}

export function nodeFiles(map: ArchMap, id: string, changed: string[]): string[] {
  return changed.filter((p) => nodeForPath(map, p)?.id === id);
}

// The render set: the committed skeleton, plus whatever this PR introduces,
// plus a bucket so an unmapped file is never invisible on the chart.
export function mergedMap(map: ArchMap, ann: ArchAnnotation | null, unmapped: string[]): ArchMap {
  if ((ann === null || ann.added.length === 0) && unmapped.length === 0) return map;
  const nodes = [...map.nodes];
  const edges = [...map.edges];
  for (const a of ann?.added ?? []) {
    if (nodes.some((n) => n.id === a.id)) continue;
    nodes.push({ id: a.id, label: a.label || a.id, role: "", files: a.files });
  }
  const known = new Set(nodes.map((n) => n.id));
  for (const a of ann?.added ?? []) {
    for (const e of a.edges) {
      if (known.has(e.to)) edges.push({ from: a.id, to: e.to, carries: e.carries });
    }
  }
  if (unmapped.length > 0) {
    nodes.push({ id: UNMAPPED_ID, label: `unmapped (${unmapped.length})`, role: "", files: unmapped });
  }
  return { ...map, nodes, edges };
}

// The whole render set in one pass, and the only way the overlay should build
// it. Ordering is the point: what the PR adds claims its files first, so the
// bucket sweeps what is genuinely left over rather than double-counting a file
// an added node already owns. The returned unmapped list is exactly what the
// bucket node holds, so a stale count taken from it can never disagree with the
// label on the chart.
export function renderSet(
  map: ArchMap,
  ann: ArchAnnotation | null,
  changed: string[],
): { map: ArchMap; unmapped: string[] } {
  const withAdded = mergedMap(map, ann, []);
  const unmapped = unmappedPaths(withAdded, changed);
  return { map: mergedMap(withAdded, null, unmapped), unmapped };
}

export function nodeStates(
  map: ArchMap,
  ann: ArchAnnotation | null,
  changed: string[],
): Map<string, NodeState> {
  const added = new Set((ann?.added ?? []).map((a) => a.id));
  const atRisk = new Set((ann?.atRisk ?? []).map((r) => r.node));
  const touched = new Set<string>();
  for (const p of changed) {
    const n = nodeForPath(map, p);
    if (n) touched.add(n.id);
  }
  const out = new Map<string, NodeState>();
  for (const n of map.nodes) {
    if (n.id === UNMAPPED_ID) out.set(n.id, "unmapped");
    else if (added.has(n.id)) out.set(n.id, "added");
    else if (touched.has(n.id)) out.set(n.id, "touched");
    else if (atRisk.has(n.id)) out.set(n.id, "at-risk");
    else out.set(n.id, "idle");
  }
  return out;
}
