import {
  type AC,
  AC_COMMENT_MARKER,
  applyJudgment,
  type Judgment,
  openAcs,
  parseAcComment,
  renderAcComment,
  satisfiedCount,
  selectContinuation,
} from "./acceptance.ts";
import type { MergedPR } from "./gh.ts";

export type AdvanceState = {
  round: Map<string, number>;
  prevSatisfied: Map<string, number>;
  halted: Set<string>;
  processedPRs: Set<number>;
};

export function freshAdvanceState(): AdvanceState {
  return { round: new Map(), prevSatisfied: new Map(), halted: new Set(), processedPRs: new Set() };
}

const BRANCH_RE = /eng-(\d+)/i;

export function issueFromBranch(branch: string): string | null {
  const m = BRANCH_RE.exec(branch);
  return m ? `ENG-${m[1]}` : null;
}

export type AdvanceDeps = {
  listMergedPRs: () => Promise<MergedPR[]>;
  fetchAcComment: (issueId: string) => Promise<string>;
  fetchDescription: (identifier: string) => Promise<{ id: string; description: string }>;
  judge: (open: AC[]) => Promise<Judgment>;
  writeAcComment: (issueId: string, body: string) => Promise<void>;
  activeCount: () => Promise<number>;
  maxInProgress: number;
  maxRounds: number;
  spawnContinuation: (issueNumber: string, round: number) => void;
  markReady: (identifier: string) => void;
  log: (msg: string) => void;
};

export async function advanceOnce(state: AdvanceState, deps: AdvanceDeps): Promise<void> {
  let merged: MergedPR[];
  try {
    merged = await deps.listMergedPRs();
  } catch (err) {
    deps.log(`merged PR list failed: ${err}`);
    return;
  }

  // Edge-trigger: only PRs not yet processed drive a round. Each merged PR
  // triggers at most one judged round, so the no-progress guard compares
  // satisfiedCount across genuinely-new merged PRs (completed rounds).
  const newByIdentifier = new Map<string, number[]>();
  for (const pr of merged) {
    if (state.processedPRs.has(pr.number)) continue;
    const id = issueFromBranch(pr.headRefName);
    if (!id) continue;
    const list = newByIdentifier.get(id) ?? [];
    list.push(pr.number);
    newByIdentifier.set(id, list);
  }

  for (const [identifier, prNumbers] of newByIdentifier) {
    const markAll = () => {
      for (const n of prNumbers) state.processedPRs.add(n);
    };
    if (state.halted.has(identifier)) {
      markAll(); // don't rescan a halted issue's PRs every tick
      continue;
    }
    try {
      const { id } = await deps.fetchDescription(identifier);
      const body = await deps.fetchAcComment(id);
      if (!body.includes(AC_COMMENT_MARKER)) {
        markAll();
        continue;
      }
      const acs = parseAcComment(body);
      if (acs.length === 0) {
        markAll();
        continue;
      }

      const judgment = await deps.judge(openAcs(acs));
      const acs2 = applyJudgment(acs, judgment);
      await deps.writeAcComment(id, renderAcComment(acs2));

      const round = state.round.get(identifier) ?? 0;
      const prev = state.prevSatisfied.get(identifier) ?? 0;
      const decision = selectContinuation(acs2, prev, round, deps.maxRounds);

      if (decision.kind === "complete") {
        deps.markReady(identifier);
        deps.log(`${identifier} complete`);
        markAll();
        continue;
      }
      if (decision.kind === "halt") {
        state.halted.add(identifier);
        deps.log(`${identifier} halted: ${decision.reason}`);
        markAll();
        continue;
      }
      if ((await deps.activeCount()) >= deps.maxInProgress) {
        // Defer without marking processed so this PR retries next tick.
        deps.log(`${identifier} continuation deferred (WIP cap)`);
        continue;
      }
      const number = identifier.split("-")[1];
      deps.spawnContinuation(number, round + 1);
      state.round.set(identifier, round + 1);
      state.prevSatisfied.set(identifier, satisfiedCount(acs2));
      markAll();
      deps.log(`${identifier} continuing (round ${round + 1})`);
    } catch (err) {
      // Leave unprocessed so a transient failure retries next tick.
      deps.log(`advance failed for ${identifier}: ${err}`);
    }
  }
}
