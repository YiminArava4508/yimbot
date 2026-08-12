// Which slice of the board this instance works. Parsed from LABEL_FILTER:
// "bot" works only labelled tickets, "!bot" works everything else, unset works
// everything. Two instances sharing one Linear account partition the board by
// running opposite filters.
export type LabelFilter = { label: string; negated: boolean } | null;

export function parseLabelFilter(raw: string | undefined): LabelFilter {
  const value = raw?.trim() ?? "";
  if (!value) return null;
  const negated = value.startsWith("!");
  const label = (negated ? value.slice(1) : value).trim().toLowerCase();
  if (!label) return null;
  return { label, negated };
}

export function labelFilterAllows(filter: LabelFilter, labels: string[]): boolean {
  if (!filter) return true;
  const has = labels.some((l) => l.trim().toLowerCase() === filter.label);
  return filter.negated ? !has : has;
}

export function filterByLabel<T extends { labels: string[] }>(filter: LabelFilter, items: T[]): T[] {
  if (!filter) return items;
  return items.filter((item) => labelFilterAllows(filter, item.labels));
}

export function describeLabelFilter(filter: LabelFilter): string {
  if (!filter) return "every ticket";
  return filter.negated
    ? `every ticket except those labelled "${filter.label}"`
    : `only tickets labelled "${filter.label}"`;
}
