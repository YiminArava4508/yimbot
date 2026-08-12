import { ticketIdentifierFromBranch } from "./blocked.ts";
import { labelFilterAllows, type LabelFilter } from "./labels.ts";

export type PrLabelFilterOptions = {
  filter: LabelFilter;
  fetchLabels: (identifier: string) => Promise<string[]>;
  ttlMs: number;
  now: () => number;
  log: (msg: string) => void;
};

// Gate a PR list on the instance's LABEL_FILTER by reading the labels of the
// ticket its branch names. A branch with no identifier has no labels to test,
// so it counts as unlabelled: the "!bot" instance works it, the "bot" instance
// leaves it. A lookup that fails skips the PR for this tick instead of falling
// back to working it, because the fallback is exactly the duplicate session the
// filter exists to prevent.
export function makePrLabelFilter(opts: PrLabelFilterOptions) {
  const cache = new Map<string, { labels: string[]; at: number }>();

  const labelsFor = async (identifier: string): Promise<string[]> => {
    const hit = cache.get(identifier);
    if (hit && opts.now() - hit.at < opts.ttlMs) return hit.labels;
    const labels = await opts.fetchLabels(identifier);
    cache.set(identifier, { labels, at: opts.now() });
    return labels;
  };

  return async <T extends { headRefName: string }>(prs: T[]): Promise<T[]> => {
    if (!opts.filter) return prs;
    const kept: T[] = [];
    for (const pr of prs) {
      const identifier = ticketIdentifierFromBranch(pr.headRefName);
      if (!identifier) {
        if (labelFilterAllows(opts.filter, [])) kept.push(pr);
        continue;
      }
      try {
        if (labelFilterAllows(opts.filter, await labelsFor(identifier))) kept.push(pr);
      } catch (err) {
        opts.log(`skipping ${pr.headRefName} this tick: label lookup failed (${err})`);
      }
    }
    return kept;
  };
}
