// src/tui-review.ts
// Guided review overlay: a plan pane (AI-ordered groups of changed files) and
// a diff pane, over the board the way the settings panel is. Everything that
// can be pure is exported below and unit-tested; the blessed shell stays thin.
import blessed from "neo-blessed";
import { escapeTags, renderFileDiff, type FileDiff } from "./review-diff.ts";
import type { ReviewGroup, ReviewGroups } from "./review-groups.ts";

export function flattenFiles(groups: ReviewGroup[]): string[] {
  return groups.flatMap((g) => g.files);
}

export function groupOf(groups: ReviewGroup[], path: string): ReviewGroup | null {
  return groups.find((g) => g.files.includes(path)) ?? null;
}

// The next unviewed file after `from`, wrapping; `from` itself when every
// file is viewed so space on the last file does not jump anywhere.
export function nextUnviewed(files: string[], viewed: Set<string>, from: number): number {
  for (let step = 1; step <= files.length; step++) {
    const i = (from + step) % files.length;
    if (!viewed.has(files[i])) return i;
  }
  return from;
}

export function placeholderGroups(paths: string[]): ReviewGroups {
  return { summary: "", groups: [{ title: "organizing review…", context: "", files: paths }] };
}

export function planLines(
  groups: ReviewGroup[],
  viewed: Set<string>,
  selectedPath: string | null,
): { lines: string[]; selectedLine: number } {
  const lines: string[] = [];
  let selectedLine = -1;
  for (const g of groups) {
    lines.push(`{bold}${escapeTags(g.title)}{/bold}`);
    for (const f of g.files) {
      const mark = viewed.has(f) ? " {green-fg}✓{/green-fg} " : "   ";
      if (f === selectedPath) {
        selectedLine = lines.length;
        lines.push(`{inverse}${mark}${escapeTags(f)}{/inverse}`);
      } else {
        lines.push(`${mark}${escapeTags(f)}`);
      }
    }
  }
  return { lines, selectedLine };
}

export function diffPaneLines(group: ReviewGroup | null, fd: FileDiff | null): string[] {
  const out: string[] = [];
  if (group && group.context) {
    out.push(`{grey-fg}${escapeTags(group.context)}{/grey-fg}`, "");
  }
  if (fd) out.push(...renderFileDiff(fd));
  else out.push("{grey-fg}loading diff…{/grey-fg}");
  return out;
}

export function reviewHeader(pr: number, title: string, viewedCount: number, total: number): string {
  return `PR #${pr}  ${escapeTags(title)}  |  ${viewedCount}/${total} viewed`;
}

export function reviewFooterHint(s: {
  total: number;
  allViewed: boolean;
  isDraft: boolean;
  diffFocused: boolean;
}): string {
  if (s.total === 0) return "loading…   q back";
  const focus = s.diffFocused ? "tab file list" : "tab diff";
  let done = "";
  if (s.allViewed && s.isDraft) done = "   {green-fg}y mark PR ready{/green-fg}";
  else if (s.allViewed) done = "   {green-fg}review complete{/green-fg}";
  return `j/k file   space viewed   g/G first/last   ${focus}${done}   q back`;
}

// Same discipline as footerLayout/settingsPanelLayout: exported plain records
// so the layout test exercises these exact objects. keys+vi on the diff pane
// gives blessed's own j/k scrolling when it is focused; the plan pane's keys
// are handled by openReview so headers can be skipped during selection.
export function reviewLayout(): Record<"header" | "plan" | "diff" | "footer", Record<string, unknown>> {
  return {
    header: { top: 0, left: 0, width: "100%", height: 1, wrap: false, tags: true },
    plan: {
      top: 1, left: 0, width: "30%", bottom: 1, tags: true,
      scrollable: true, alwaysScroll: true,
      border: { type: "line" }, label: " review plan ",
    },
    diff: {
      top: 1, left: "30%", right: 0, bottom: 1, tags: true, keys: true, vi: true,
      scrollable: true, alwaysScroll: true,
      border: { type: "line" }, label: " diff ",
      scrollbar: { ch: " ", style: { inverse: true } },
    },
    footer: { bottom: 0, left: 0, width: "100%", height: 1, wrap: false, tags: true, style: { fg: "white" } },
  };
}
