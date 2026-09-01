// src/review-context.ts
// Pure builder for the review context file the embedded claude session reads.
// No fs: markdown in/out so tests stay hermetic; the shell writes the file.
import { join } from "node:path";
import type { FileDiff } from "./review-diff.ts";

export const CONTEXT_RELPATH = ".yimbot/review-context.md";

export function contextFilePath(cwd: string): string {
  return join(cwd, CONTEXT_RELPATH);
}

export function patchText(fd: FileDiff): string {
  return fd.lines
    .filter((l) => l.kind !== "meta")
    .map((l) => l.text)
    .join("\n");
}

export function togglePin(pinned: Set<string>, path: string): Set<string> {
  const next = new Set(pinned);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

// Cheap change detector for lazy injection: the overlay rewrites the context
// file only when this differs from the last written signature, so moving the
// selection never touches disk until the operator actually types at claude.
export function contextSignature(selected: string | null, pinned: Set<string>): string {
  return JSON.stringify([selected, [...pinned].sort()]);
}

function fileSection(heading: string, fd: FileDiff): string[] {
  return [`## ${heading}: ${fd.path}`, "", "```diff", patchText(fd), "```", ""];
}

export function contextMarkdown(
  pr: number,
  selected: string | null,
  pinned: Set<string>,
  diffs: FileDiff[],
): string {
  const byPath = new Map(diffs.map((d) => [d.path, d]));
  const out = [`# Review context: PR #${pr}`, ""];
  const sel = selected === null ? undefined : byPath.get(selected);
  if (sel) out.push(...fileSection("Current file", sel));
  for (const p of [...pinned].sort()) {
    if (p === selected) continue;
    const fd = byPath.get(p);
    if (fd) out.push(...fileSection("Pinned", fd));
  }
  if (!sel && pinned.size === 0) out.push("(no file selected)");
  return out.join("\n");
}
