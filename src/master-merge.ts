import type { ChecksInfo, MergeableInfo, PrState, UnresolvedInfo, YimbotPr } from "./gh.ts";
import type { MasterMergeEntry } from "./master-merge-state.ts";
import { buildMasterReviewPrompt, MAX_DIFF_CHARS, parseMasterVerdict } from "./master-review.ts";

export type MasterMergeDeps = {
  enabled: () => boolean;
  authors: Set<string>;
  listPrs: () => Promise<YimbotPr[]>;
  checks: (n: number) => Promise<ChecksInfo>;
  mergeable: (n: number) => Promise<MergeableInfo>;
  unresolved: (n: number) => Promise<UnresolvedInfo>;
  prState: (n: number) => Promise<PrState>;
  diff: (n: number) => Promise<string>;
  review: (prompt: string) => Promise<string>;
  comment: (n: number, body: string) => Promise<void>;
  markReady: (n: number) => Promise<void>;
  merge: (n: number, headSha: string) => Promise<void>;
  loadState: () => Record<string, MasterMergeEntry>;
  saveState: (s: Record<string, MasterMergeEntry>) => void;
  onMerged: (pr: YimbotPr) => void;
  onFindings: (pr: YimbotPr, findings: string[]) => void;
  log: (msg: string) => void;
};

type State = Record<string, MasterMergeEntry>;

const MAX_ATTEMPTS = 3;

function gateFailure(pr: YimbotPr, checks: ChecksInfo, mergeable: MergeableInfo): string | null {
  if (checks.headSha !== pr.headSha || mergeable.headSha !== pr.headSha) return "head sha moved";
  if (checks.state !== "passing") return `CI ${checks.state}`;
  if (mergeable.state !== "mergeable") return `mergeable ${mergeable.state}`;
  return null;
}

// Returns the live PR state when every cheap gate passes, null otherwise.
async function passGates(pr: YimbotPr, deps: MasterMergeDeps): Promise<PrState | null> {
  const failure = gateFailure(pr, await deps.checks(pr.number), await deps.mergeable(pr.number));
  if (failure) {
    deps.log(`master: #${pr.number} skipped: ${failure}`);
    return null;
  }
  const unresolved = await deps.unresolved(pr.number);
  if (unresolved.count !== 0) {
    deps.log(`master: #${pr.number} skipped: ${unresolved.count} unresolved threads`);
    return null;
  }
  const prState = await deps.prState(pr.number);
  if (prState.changesRequested) {
    deps.log(`master: #${pr.number} skipped: changes requested`);
    return null;
  }
  return prState;
}

function findingsComment(findings: string[]): string {
  return ["Review found problems, not merging:", "", ...findings.map((f) => `- ${f}`)].join("\n");
}

// Records the new entry in state before any callback runs, so a throwing callback cannot cause a re-review.
async function runReview(pr: YimbotPr, state: State, deps: MasterMergeDeps): Promise<MasterMergeEntry | null> {
  const key = String(pr.number);
  const prior = state[key]?.sha === pr.headSha ? state[key] : undefined;
  const diff = await deps.diff(pr.number);
  if (diff.length > MAX_DIFF_CHARS) {
    deps.log(`master: #${pr.number} skipped: diff too large (${diff.length} chars)`);
    return null;
  }
  // The diff is fetched by PR number, so confirm the head did not move while fetching it.
  if ((await deps.checks(pr.number)).headSha !== pr.headSha) {
    deps.log(`master: #${pr.number} skipped: head sha moved during diff fetch`);
    return null;
  }
  const entry: MasterMergeEntry = { sha: pr.headSha, clean: false, commented: false, attempts: (prior?.attempts ?? 0) + 1 };
  state[key] = entry;
  let out: string;
  try {
    out = await deps.review(buildMasterReviewPrompt(pr.headRefName, diff));
  } catch (err) {
    deps.log(`master: #${pr.number} review run failed (attempt ${entry.attempts}): ${err}`);
    return entry;
  }
  const verdict = parseMasterVerdict(out);
  if (!verdict) {
    deps.log(`master: #${pr.number} review output unparseable (attempt ${entry.attempts})`);
    return entry;
  }
  entry.clean = verdict.clean;
  if (!verdict.clean) {
    try {
      await deps.comment(pr.number, findingsComment(verdict.findings));
    } catch (err) {
      deps.log(`master: #${pr.number} findings comment failed (attempt ${entry.attempts}): ${err}`);
      return entry;
    }
    entry.commented = true;
    try {
      deps.onFindings(pr, verdict.findings);
    } catch (err) {
      deps.log(`master: #${pr.number} onFindings failed: ${err}`);
    }
  }
  return entry;
}

// Returns true when the PR was merged.
async function processPr(pr: YimbotPr, state: State, deps: MasterMergeDeps): Promise<boolean> {
  const key = String(pr.number);
  const cached = state[key]?.sha === pr.headSha ? state[key] : undefined;
  if (cached && !cached.clean && cached.commented) return false;
  const needsReview = !cached?.clean;
  if (needsReview && (cached?.attempts ?? 0) >= MAX_ATTEMPTS) {
    deps.log(`master: #${pr.number} skipped: review failed ${MAX_ATTEMPTS} times for ${pr.headSha}`);
    return false;
  }
  let prState = await passGates(pr, deps);
  if (!prState) return false;

  if (needsReview) {
    const reviewed = await runReview(pr, state, deps);
    if (!reviewed?.clean) return false;
    // The review can take minutes; a human may have blocked the PR meanwhile.
    prState = await passGates(pr, deps);
    if (!prState) return false;
  }

  if (pr.isDraft || prState.isDraft) await deps.markReady(pr.number);
  try {
    await deps.merge(pr.number, pr.headSha);
  } catch (err) {
    deps.log(`master: #${pr.number} merge rejected, retrying next tick: ${err}`);
    return false;
  }
  deps.log(`master: merged #${pr.number} at ${pr.headSha}`);
  try {
    deps.onMerged(pr);
  } catch (err) {
    deps.log(`master: #${pr.number} onMerged failed: ${err}`);
  }
  return true;
}

export async function masterMergeOnce(deps: MasterMergeDeps): Promise<void> {
  if (!deps.enabled()) return;
  let prs: YimbotPr[];
  try {
    prs = await deps.listPrs();
  } catch (err) {
    deps.log(`master: PR list failed: ${err}`);
    return;
  }
  const open = new Set(prs.map((p) => String(p.number)));
  const state: State = Object.fromEntries(Object.entries(deps.loadState()).filter(([k]) => open.has(k)));
  deps.saveState(state);

  for (const pr of prs) {
    if (!deps.authors.has(pr.author)) continue;
    let merged = false;
    try {
      merged = await processPr(pr, state, deps);
    } catch (err) {
      deps.log(`master: #${pr.number} skipped: ${err}`);
    }
    deps.saveState(state);
    if (merged) return;
  }
}
