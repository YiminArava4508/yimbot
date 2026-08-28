// src/review-order.ts
// The review queue's AI step: one headless prompt that orders the ready-to-review
// draft PRs into a recommended review sequence, with a one-line reason per PR.
// Titles, bodies and diffstats only, never diff bodies: enough signal to order,
// small enough to stay one prompt. Mirrors review-groups.ts.
import type { PrOrderMeta } from "./gh.ts";
import { extractJsonObject } from "./json-extract.ts";

export type OrderPr = PrOrderMeta & { number: number };
export type OrderEntry = { pr: number; reason: string };
export type OrderRunner = (prompt: string) => Promise<string>;

export function orderingPrompt(prs: OrderPr[]): string {
  const list = prs
    .map((p) => [`#${p.number}: ${p.title} (+${p.additions}/-${p.deletions})`, p.body || "(no description)"].join("\n"))
    .join("\n\n");
  return [
    "You are ordering a batch of draft PRs, all by the same author and all ready for review,",
    "into the sequence a reviewer should read them in.",
    "",
    "PRs:",
    list,
    "",
    "Order them so foundations read before their dependents (stacked series in stack order),",
    "related PRs stay adjacent so reviewer context carries over, and the change most likely",
    "to need rework from review feedback (schema changes, big diffs) gets its own slot last.",
    "For each PR give a short reason (a few words) for its position.",
    "Reply with ONLY a JSON object, no prose:",
    '{"order": [{"pr": <number>, "reason": "<why this position>"}, ...]}',
    "Every PR must appear exactly once. Use only the PR numbers listed above.",
  ].join("\n");
}

// Tolerant the way parseGroups is (src/review-groups.ts): outermost {...}, shape
// checks field by field, null for anything unusable. Unknown and duplicate PRs
// are dropped; PRs the model forgot are appended in listed order, reasonless.
export function parseOrder(stdout: string, prNumbers: number[]): OrderEntry[] | null {
  const obj = extractJsonObject(stdout);
  if (obj === null) return null;
  const o = obj as { order?: unknown };
  if (!Array.isArray(o.order)) return null;
  const known = new Set(prNumbers);
  const seen = new Set<number>();
  const entries: OrderEntry[] = [];
  for (const raw of o.order) {
    const e = raw as { pr?: unknown; reason?: unknown };
    if (typeof e.pr !== "number" || !known.has(e.pr) || seen.has(e.pr)) continue;
    seen.add(e.pr);
    entries.push({ pr: e.pr, reason: typeof e.reason === "string" ? e.reason : "" });
  }
  if (entries.length === 0) return null;
  for (const n of prNumbers) if (!seen.has(n)) entries.push({ pr: n, reason: "" });
  return entries;
}

const STACK_MARKER = /\[(\d+)\/\d+\]/;

function stackIndex(title: string): number | null {
  const m = STACK_MARKER.exec(title);
  return m ? Number(m[1]) : null;
}

// Deterministic and free: stacked series first in stack order, then smallest
// diff first, PR number as the tiebreak.
export function fallbackOrder(prs: OrderPr[]): OrderEntry[] {
  const sorted = [...prs].sort((a, b) => {
    const sa = stackIndex(a.title);
    const sb = stackIndex(b.title);
    if (sa !== null && sb !== null && sa !== sb) return sa - sb;
    if (sa !== null && sb === null) return -1;
    if (sa === null && sb !== null) return 1;
    const size = a.additions + a.deletions - (b.additions + b.deletions);
    return size !== 0 ? size : a.number - b.number;
  });
  return sorted.map((p) => ({ pr: p.number, reason: "" }));
}

export async function fetchOrder(
  run: OrderRunner,
  prs: OrderPr[],
): Promise<{ order: OrderEntry[]; usedFallback: boolean }> {
  const numbers = prs.map((p) => p.number);
  try {
    const parsed = parseOrder(await run(orderingPrompt(prs)), numbers);
    if (parsed) return { order: parsed, usedFallback: false };
  } catch {
    // Runner failure (claude missing, timeout): same fallback as junk output.
  }
  return { order: fallbackOrder(prs), usedFallback: true };
}

export function orderCacheKey(prNumbers: number[]): string {
  return [...prNumbers].sort((a, b) => a - b).join(",");
}

// Non-blocking cache in front of fetchOrder for the board's render loop: ensure()
// kicks at most one async fetch per distinct PR set — landed orders are memoized
// and an in-flight set is never restarted, so a set flapping A/B/A costs one
// fetch per distinct set, not one per flap. get() serves the current set's landed
// order (null while it is still fetching, so a stale order is never shown against
// a different set). Meta reads are independent: a PR whose read fails is ordered
// last by the board's applyOrder rather than poisoning the whole batch, and if
// every read fails the order degrades to PR-number order.
export type OrderSourceDeps = {
  fetchMeta: (pr: number) => Promise<PrOrderMeta>;
  run: OrderRunner;
};

function numberOrder(prNumbers: number[]): OrderEntry[] {
  return [...prNumbers].sort((a, b) => a - b).map((pr) => ({ pr, reason: "" }));
}

export function makeOrderFetcher(
  deps: OrderSourceDeps & { onUpdate: () => void },
): { ensure: (prNumbers: number[]) => void; get: () => OrderEntry[] | null } {
  let currentKey = "";
  const cache = new Map<string, OrderEntry[]>();
  const inFlight = new Set<string>();
  const ensure = (prNumbers: number[]) => {
    const key = orderCacheKey(prNumbers);
    currentKey = key;
    if (prNumbers.length === 0 || cache.has(key) || inFlight.has(key)) return;
    inFlight.add(key);
    void (async () => {
      let result: OrderEntry[];
      try {
        const settled = await Promise.allSettled(prNumbers.map((n) => deps.fetchMeta(n)));
        const prs = prNumbers.flatMap((n, i) => {
          const s = settled[i];
          return s.status === "fulfilled" ? [{ number: n, ...s.value }] : [];
        });
        result = prs.length > 0 ? (await fetchOrder(deps.run, prs)).order : numberOrder(prNumbers);
      } catch {
        result = numberOrder(prNumbers);
      } finally {
        inFlight.delete(key);
      }
      cache.set(key, result);
      if (currentKey === key) deps.onUpdate();
    })();
  };
  return { ensure, get: () => cache.get(currentKey) ?? null };
}
