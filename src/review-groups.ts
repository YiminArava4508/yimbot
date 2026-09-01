// src/review-groups.ts
// The review's AI step: one headless prompt that organizes changed
// files into ordered, contextualized groups. Paths and diffstats only, never
// diff bodies: enough signal to group, small enough to stay one prompt.
import type { FileDiff } from "./review-diff.ts";
import { extractJsonObject } from "./json-extract.ts";

export type ReviewGroup = { title: string; context: string; files: string[] };
export type ReviewGroups = { summary: string; groups: ReviewGroup[] };
export type GroupingRunner = (prompt: string) => Promise<string>;
export type PrMeta = { number: number; title: string; body: string };
export type FileStat = Pick<FileDiff, "path" | "additions" | "deletions" | "status"> & { hunks: string[] };

const HUNK_CAP = 8;

// Hunk-header contexts ("@@ ... @@ function foo(") are the cheapest symbol-level
// signal git gives us: enough to tell which files touch the same code without
// shipping diff bodies.
export function fileStats(diffs: FileDiff[]): FileStat[] {
  return diffs.map((d) => {
    const hunks: string[] = [];
    for (const l of d.lines) {
      if (l.kind !== "hunk") continue;
      const ctx = l.text.replace(/^@@[^@]*@@ ?/, "").trim();
      if (ctx !== "" && !hunks.includes(ctx)) hunks.push(ctx);
      if (hunks.length === HUNK_CAP) break;
    }
    return { path: d.path, additions: d.additions, deletions: d.deletions, status: d.status, hunks };
  });
}

function fileLine(f: FileStat): string {
  const stat = f.status === "modified" ? "" : `${f.status}, `;
  const head = `- ${f.path} (${stat}+${f.additions}/-${f.deletions})`;
  if (f.hunks.length === 0) return head;
  return `${head}\n  in: ${f.hunks.join("; ")}`;
}

export function groupingPrompt(pr: PrMeta, files: FileStat[]): string {
  const list = files.map(fileLine).join("\n");
  return [
    `You are a principal engineer planning a code review of PR #${pr.number}: ${pr.title}.`,
    "PR description:",
    pr.body || "(none)",
    "",
    "Changed files (status when not modified, diffstat, and the enclosing symbols git saw change):",
    list,
    "",
    "Build the review plan the way a senior reviewer reads a change:",
    "- Find the heart of the PR first: the files where behavior or a contract actually",
    "  changes. Every other file is collateral in service of that change.",
    "- Group by concern, not by directory or file type: a group is one reviewable idea",
    "  (a schema change plus its call sites, a bug fix plus the test that pins it).",
    "  The symbol hints above tell you which files touch the same code.",
    "- Order groups so understanding compounds: contracts, types, and schemas first,",
    "  then core logic, then wiring and call sites, then tests, then the rest.",
    "- Quarantine purely mechanical churn (lockfiles, generated code, snapshots,",
    "  renames, formatting-only edits) in a final group titled so the reviewer knows",
    "  to skim it.",
    "- Keep each group reviewable: prefer 1-6 files, splitting a bigger concern into",
    "  narrower ones.",
    "For each group write one sentence of context: what this part of the change does",
    "and how it fits into the PR. Give the reviewer the lay of the land; do not tell",
    "them what to check, point at specifics, or restate the file list.",
    "Reply with ONLY a JSON object, no prose:",
    '{"summary": "<1-2 sentences for a reviewer new to this codebase: what the PR does and how the pieces fit together>",',
    ' "groups": [{"title": "<short label>", "context": "<one-sentence background>", "files": ["<path>", ...]}, ...]}',
    "Every file must appear in exactly one group. Use only the paths listed above.",
  ].join("\n");
}

// Tolerant the way parseJudgment is (src/judge.ts): outermost {...}, shape
// checks field by field, and a null (not a throw) for anything unusable so
// the caller can fall back. Unknown and duplicate paths are dropped; files
// the model forgot land in a trailing "Other changes" group.
export function parseGroups(stdout: string, diffPaths: string[]): ReviewGroups | null {
  const obj = extractJsonObject(stdout);
  if (obj === null) return null;
  const o = obj as { summary?: unknown; groups?: unknown };
  if (!Array.isArray(o.groups)) return null;
  const known = new Set(diffPaths);
  const seen = new Set<string>();
  const groups: ReviewGroup[] = [];
  for (const raw of o.groups) {
    const g = raw as { title?: unknown; context?: unknown; files?: unknown };
    if (typeof g.title !== "string" || !Array.isArray(g.files)) continue;
    const localSeen = new Set<string>();
    const files = g.files.filter((f): f is string => {
      if (typeof f !== "string") return false;
      if (!known.has(f) || seen.has(f) || localSeen.has(f)) return false;
      localSeen.add(f);
      return true;
    });
    for (const f of localSeen) seen.add(f);
    if (files.length === 0) continue;
    groups.push({ title: g.title, context: typeof g.context === "string" ? g.context : "", files });
  }
  if (groups.length === 0) return null;
  const missing = diffPaths.filter((p) => !seen.has(p));
  if (missing.length > 0) groups.push({ title: "Other changes", context: "", files: missing });
  return { summary: typeof o.summary === "string" ? o.summary : "", groups };
}

export function fallbackGroups(diffPaths: string[]): ReviewGroups {
  const buckets = new Map<string, string[]>();
  for (const p of diffPaths) {
    const slash = p.indexOf("/");
    const dir = slash === -1 ? "(root)" : p.slice(0, slash);
    const list = buckets.get(dir) ?? [];
    list.push(p);
    buckets.set(dir, list);
  }
  const groups = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([title, files]) => ({ title, context: "", files: files.sort() }));
  return { summary: "", groups };
}

export async function fetchGroups(
  run: GroupingRunner,
  pr: PrMeta,
  files: FileStat[],
): Promise<{ groups: ReviewGroups; usedFallback: boolean }> {
  const paths = files.map((f) => f.path);
  try {
    const parsed = parseGroups(await run(groupingPrompt(pr, files)), paths);
    if (parsed) return { groups: parsed, usedFallback: false };
  } catch {
    // Runner failure (claude missing, timeout): same fallback as junk output.
  }
  return { groups: fallbackGroups(paths), usedFallback: true };
}
