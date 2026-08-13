import { ticketIdentifierFromBranch } from "./blocked.ts";
import { labelFilterAllows, type LabelFilter } from "./labels.ts";
import { isMissingEntityError } from "./linear-api.ts";

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
// leaves it. A branch that looks like a ticket but isn't one (GitHub's
// revert-1234-eng-1-... branches, hotfix-2-..., etc.) gets the same treatment:
// Linear's "not found" counts as unlabelled rather than a lookup failure. Any
// other lookup failure (network, 5xx, rate limiting) skips the PR for this tick
// instead of falling back to working it, because the fallback is exactly the
// duplicate session the filter exists to prevent.
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
        if (isMissingEntityError(err)) {
          if (labelFilterAllows(opts.filter, [])) kept.push(pr);
          continue;
        }
        opts.log(`skipping ${pr.headRefName} this tick: label lookup failed (${err})`);
      }
    }
    return kept;
  };
}
