import type { OpenPR } from "./gh.ts";

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// EXTRA_REPOS as a list of owner/name slugs. Anything else (a URL, a bare
// name, a nested path) fails startup by name rather than reaching gh as a
// bad GH_REPO value every tick.
export function parseExtraRepos(csv: string): string[] {
  const slugs = csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const slug of slugs) {
    if (!SLUG.test(slug)) throw new Error(`EXTRA_REPOS entry is not owner/name: ${slug}`);
  }
  return slugs;
}

// The codebase repo's open PRs followed by each extra repo's. Every per-PR map
// downstream (ready latch, soak clock, CI dedup, the board's pr: fallback key)
// is keyed by PR number alone, so a number an earlier list already claimed is
// dropped for the tick instead of being acted on against the wrong repo.
export function mergeOpenPRs(primary: OpenPR[], extras: OpenPR[][], log: (msg: string) => void): OpenPR[] {
  const out = [...primary];
  const taken = new Set(primary.map((p) => p.number));
  for (const list of extras) {
    for (const pr of list) {
      if (taken.has(pr.number)) {
        log(`skipping ${pr.repo}#${pr.number} this tick: PR number already taken by another repo`);
        continue;
      }
      taken.add(pr.number);
      out.push(pr);
    }
  }
  return out;
}
