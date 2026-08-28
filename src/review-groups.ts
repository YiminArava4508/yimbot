// src/review-groups.ts
// The guided review's AI step: one headless prompt that organizes changed
// files into ordered, contextualized groups. Paths and diffstats only, never
// diff bodies: enough signal to group, small enough to stay one prompt.
import type { FileDiff } from "./review-diff.ts";

export type ReviewGroup = { title: string; context: string; files: string[] };
export type ReviewGroups = { summary: string; groups: ReviewGroup[] };
export type GroupingRunner = (prompt: string) => Promise<string>;
export type PrMeta = { number: number; title: string; body: string };
export type FileStat = Pick<FileDiff, "path" | "additions" | "deletions">;

export function groupingPrompt(pr: PrMeta, files: FileStat[]): string {
  const list = files.map((f) => `- ${f.path} (+${f.additions}/-${f.deletions})`).join("\n");
  return [
    `You are organizing a code review of PR #${pr.number}: ${pr.title}.`,
    "PR description:",
    pr.body || "(none)",
    "",
    "Changed files:",
    list,
    "",
    "Group these files into a guided review plan: related files together, ordered so the",
    "core change reads first and collateral (tests, wiring, fixtures, docs) after.",
    "For each group write one or two sentences of context: what the group changes and",
    "what a reviewer should look for.",
    "Reply with ONLY a JSON object, no prose:",
    '{"summary": "<one paragraph on what this PR does>",',
    ' "groups": [{"title": "<short label>", "context": "<what to look for>", "files": ["<path>", ...]}, ...]}',
    "Every file must appear in exactly one group. Use only the paths listed above.",
  ].join("\n");
}

// Tolerant the way parseJudgment is (src/judge.ts): outermost {...}, shape
// checks field by field, and a null (not a throw) for anything unusable so
// the caller can fall back. Unknown and duplicate paths are dropped; files
// the model forgot land in a trailing "Other changes" group.
export function parseGroups(stdout: string, diffPaths: string[]): ReviewGroups | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
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
