// src/queue-overlap.ts
// The merge queue batches PRs together, and PRs that edit the same files kick
// each other out of the batch. This gate runs before yimbot puts a PR in the
// queue (ready label, or a re-queue after a block): of PRs that overlap, only
// the oldest goes in and the rest wait on it until it merges.

export type QueuedPr = { n: number; headSha: string; files: string[] };
export type Candidate = { n: number; headSha?: string };

export function filesOverlap(a: string[], b: string[]): boolean {
  const set = new Set(a);
  return b.some((f) => set.has(f));
}

// For each candidate: null when it may queue, else the PR number it waits on.
// Already-queued PRs always win (they cannot be pulled back); candidates then
// go oldest first (lowest PR number), each holding back the later ones it
// overlaps.
export function serializeOverlaps(queued: QueuedPr[], candidates: QueuedPr[]): Map<number, number | null> {
  const result = new Map<number, number | null>();
  const taken = queued.filter((q) => !candidates.some((c) => c.n === q.n));
  for (const c of [...candidates].sort((a, b) => a.n - b.n)) {
    const holder = taken.find((t) => filesOverlap(t.files, c.files));
    result.set(c.n, holder ? holder.n : null);
    if (!holder) taken.push(c);
  }
  return result;
}

export type GateDeps = {
  // Open PRs that carry the ready label right now, with their file lists.
  listQueued: () => Promise<QueuedPr[]>;
  fetchFiles: (prNumber: number) => Promise<{ headSha: string; files: string[] }>;
  log: (msg: string) => void;
};

export type QueueGate = (candidates: Candidate[]) => Promise<Map<number, number | null>>;

export function createQueueGate(deps: GateDeps): QueueGate {
  // Per PR: the file list for one head SHA. A moved head invalidates it.
  const cache = new Map<number, { headSha: string; files: string[] }>();
  return async (candidates) => {
    const out = new Map<number, number | null>();
    if (candidates.length === 0) return out;
    let queued: QueuedPr[];
    try {
      queued = await deps.listQueued();
    } catch (err) {
      deps.log(`queued PR list failed, queueing without an overlap check: ${err}`);
      for (const c of candidates) out.set(c.n, null);
      return out;
    }
    if (cache.size > 500) cache.clear();
    for (const q of queued) cache.set(q.n, { headSha: q.headSha, files: q.files });
    const known: QueuedPr[] = [];
    for (const c of candidates) {
      const hit = cache.get(c.n);
      if (hit && (c.headSha === undefined || c.headSha === hit.headSha)) {
        known.push({ n: c.n, ...hit });
        continue;
      }
      try {
        const fresh = await deps.fetchFiles(c.n);
        cache.set(c.n, fresh);
        known.push({ n: c.n, ...fresh });
      } catch (err) {
        deps.log(`file list failed for PR #${c.n}, queueing it without an overlap check: ${err}`);
        out.set(c.n, null);
      }
    }
    for (const [n, holder] of serializeOverlaps(queued, known)) out.set(n, holder);
    return out;
  };
}
