// src/arch-annotate.ts
// The flow chart's AI step: one headless prompt that lays this PR over the
// committed architecture map. Paths, diffstats and hunk symbols only, the same
// input the grouping call gets, so both stay one small prompt each.
import { extractJsonObject } from "./json-extract.ts";
import type { ArchAnnotation, ArchMap } from "./arch-map.ts";
import type { FileStat, PrMeta } from "./review-groups.ts";

export type AnnotationRunner = (prompt: string) => Promise<string>;

function fileLine(f: FileStat): string {
  const stat = f.status === "modified" ? "" : `${f.status}, `;
  const head = `- ${f.path} (${stat}+${f.additions}/-${f.deletions})`;
  if (f.hunks.length === 0) return head;
  return `${head}\n  in: ${f.hunks.join("; ")}`;
}

export function annotationPrompt(map: ArchMap, pr: PrMeta, files: FileStat[]): string {
  const nodes = map.nodes.map((n) => `- ${n.id}: ${n.label}${n.role ? ` (${n.role})` : ""}`).join("\n");
  const edges = map.edges.map((e) => `- ${e.from} -> ${e.to} (${e.carries})`).join("\n");
  return [
    `You are a principal engineer reading PR #${pr.number}: ${pr.title}, against a map of this codebase's runtime.`,
    "PR description:",
    pr.body || "(none)",
    "",
    "Nodes:",
    nodes,
    "Edges:",
    edges || "(none)",
    "",
    "Changed files (status when not modified, diffstat, and the enclosing symbols git saw change):",
    files.map(fileLine).join("\n"),
    "",
    "Answer three questions and nothing else:",
    "- Which nodes does this change land on, and what does it do at each one.",
    "- Which nodes does it NOT edit that consume a shape, signature or contract it moved.",
    "  These are the ones a reviewer misses. Name the edge the risk travels along.",
    "  Say nothing here when nothing qualifies; an invented risk is worse than none.",
    "- Does this PR introduce a subsystem the map has no node for. If so, declare it",
    "  with the changed files it owns and its edges into existing nodes.",
    "Do not judge the change, suggest fixes, or list findings. Describe the flow.",
    "Reply with ONLY a JSON object, no prose:",
    '{"flow": "<one paragraph: the path data takes through the part of the system this PR touches>",',
    ' "touched": [{"node": "<id>", "note": "<what this PR does here>"}],',
    ' "atRisk": [{"node": "<id>", "why": "<what it consumes that moved>", "viaEdge": "<from->to>"}],',
    ' "added": [{"id": "<new id>", "label": "<short>", "files": ["<path>"], "edges": [{"to": "<id>", "carries": "<what>"}]}]}',
    "Use only the node ids listed above, plus ids you declare in added.",
  ].join("\n");
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// Tolerant the way normalizeGroups is: field by field, unknown ids dropped,
// null rather than a throw so the overlay can fall back to lit/dim only.
export function normalizeAnnotation(obj: unknown, map: ArchMap): ArchAnnotation | null {
  if (obj === null || typeof obj !== "object") return null;
  const o = obj as { flow?: unknown; touched?: unknown; atRisk?: unknown; added?: unknown };
  if (o.flow !== undefined && typeof o.flow !== "string") return null;
  const known = new Set(map.nodes.map((n) => n.id));
  const rawAdded = Array.isArray(o.added) ? o.added : [];
  const added: ArchAnnotation["added"] = [];
  for (const entry of rawAdded) {
    const a = entry as { id?: unknown; label?: unknown; files?: unknown };
    if (typeof a.id !== "string" || a.id === "" || known.has(a.id)) continue;
    added.push({ id: a.id, label: str(a.label) || a.id, files: stringList(a.files), edges: [] });
    known.add(a.id);
  }
  // Second pass: an added node may point at another added node, so every id
  // has to be known before any edge is resolved.
  for (const a of added) {
    const src = rawAdded.find((e) => (e as { id?: unknown }).id === a.id) as { edges?: unknown } | undefined;
    for (const entry of Array.isArray(src?.edges) ? src.edges : []) {
      const edge = entry as { to?: unknown; carries?: unknown };
      if (typeof edge.to === "string" && known.has(edge.to)) a.edges.push({ to: edge.to, carries: str(edge.carries) });
    }
  }
  const touched: ArchAnnotation["touched"] = [];
  for (const entry of Array.isArray(o.touched) ? o.touched : []) {
    const t = entry as { node?: unknown; note?: unknown };
    if (typeof t.node === "string" && known.has(t.node)) touched.push({ node: t.node, note: str(t.note) });
  }
  const atRisk: ArchAnnotation["atRisk"] = [];
  for (const entry of Array.isArray(o.atRisk) ? o.atRisk : []) {
    const r = entry as { node?: unknown; why?: unknown; viaEdge?: unknown };
    if (typeof r.node === "string" && known.has(r.node)) {
      atRisk.push({ node: r.node, why: str(r.why), viaEdge: str(r.viaEdge) });
    }
  }
  const flow = str(o.flow);
  if (flow === "" && touched.length === 0 && atRisk.length === 0 && added.length === 0) return null;
  return { flow, touched, atRisk, added };
}

export function parseAnnotation(stdout: string, map: ArchMap): ArchAnnotation | null {
  return normalizeAnnotation(extractJsonObject(stdout), map);
}

export async function fetchAnnotation(
  run: AnnotationRunner,
  map: ArchMap,
  pr: PrMeta,
  files: FileStat[],
): Promise<ArchAnnotation | null> {
  try {
    return parseAnnotation(await run(annotationPrompt(map, pr, files)), map);
  } catch {
    // Runner failure (claude missing, timeout): the same null the parser
    // returns, so the chart falls back to touched-only without a special case.
    return null;
  }
}
