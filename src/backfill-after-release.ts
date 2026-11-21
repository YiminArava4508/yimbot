import { hasLabel } from "./labels.ts";
import type { CycleParent } from "./linear-api.ts";

export type { CycleParent };

export type BackfillItem = { parent: string; flag: string; title: string };

const FLAG_TITLE_RE = /^Remove `([^`]+)` flag \(code, then prod\)$/;

export function flagFromTitle(title: string): string | null {
  return FLAG_TITLE_RE.exec(title.trim())?.[1] ?? null;
}

// The flag-removal tickets whose PR merged and that have no after-release child
// yet, each with the archive subticket to create.
export function planBackfill(
  parents: CycleParent[],
  merged: Set<string>,
  afterReleaseLabel: string,
): BackfillItem[] {
  const items: BackfillItem[] = [];
  for (const p of parents) {
    const flag = flagFromTitle(p.title);
    if (!flag || !merged.has(p.identifier.toUpperCase())) continue;
    if (p.children.some((c) => hasLabel(c.labels, afterReleaseLabel))) continue;
    items.push({ parent: p.identifier, flag, title: `Archive \`${flag}\` flag in prod` });
  }
  return items;
}

export function archiveDescription(parent: string, flag: string): string {
  return [
    `Archive the \`${flag}\` feature flag in prod. Runs only after ${parent} is released (Done).`,
    "",
    "Before archiving, verify:",
    "- the PostHog project and flag ID for the exact key above",
    "- no experiments, surveys, dependent flags, scheduled changes, tours, early-access features, replay settings or external consumers still use it",
    "",
    "Archiving in prod is hard to reverse: get a human go first. Record the readback (flag state after archiving) in a comment.",
  ].join("\n");
}
