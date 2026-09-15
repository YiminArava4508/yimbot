import type { MergedPR } from "./gh.ts";
import { issueFromBranch } from "./pr-advance.ts";
import { prKey, type QaState, type QaUnit } from "./qa-state.ts";

export const QA_MARKER = "<!-- yimbot:qa -->";

export type QaRepoConfig = { workflow: string; nonprodUrl: string };

export function qaRepoSlugEnvSuffix(repo: string): string {
  return repo.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function clean(v: string | undefined): string {
  return v?.trim() ?? "";
}

// QA_DEPLOY_WORKFLOW / QA_NONPROD_URL for the primary repo; the same names with
// _<SLUG> appended for an EXTRA_REPOS entry. Either missing disables that repo.
export function qaConfigFor(env: NodeJS.ProcessEnv, repo?: string): QaRepoConfig | null {
  const suffix = repo ? `_${qaRepoSlugEnvSuffix(repo)}` : "";
  const workflow = clean(env[`QA_DEPLOY_WORKFLOW${suffix}`]);
  const nonprodUrl = clean(env[`QA_NONPROD_URL${suffix}`]);
  if (!workflow || !nonprodUrl) return null;
  return { workflow, nonprodUrl };
}

export function qaSessionName(identifier: string): string {
  return `qa-${identifier.toLowerCase()}`;
}

export type QaFamily = { id: string; parent: string | null; children: { identifier: string; state: string }[] };

export type QaEmitKind = "qa_waiting" | "qa_awaiting_deploy" | "qa_started" | "qa_posted" | "qa_failed";

export type QaDeps = {
  listMergedPRs: () => Promise<MergedPR[]>;
  fetchFamily: (identifier: string) => Promise<QaFamily>;
  fetchState: (identifier: string) => Promise<string>;
  clearedStates: Set<string>;
  configFor: (repo?: string) => QaRepoConfig | null;
  mergeCommit: (pr: number, repo?: string) => Promise<string>;
  deployedHeadShas: (workflow: string, repo?: string) => Promise<string[]>;
  isAncestorOrEqual: (base: string, head: string, repo?: string) => Promise<boolean>;
  hasMarker: (issueId: string) => Promise<boolean>;
  hasSession: (name: string) => boolean;
  kill: (name: string) => void;
  spawn: (unit: QaUnit, children: string[], nonprodUrl: string) => void;
  activeCount: () => Promise<number>;
  maxInProgress: number;
  sessionTimeoutMs: number;
  now: () => number;
  emit: (kind: QaEmitKind, identifier: string) => void;
  log: (msg: string) => void;
};

function isMissing(err: unknown): boolean {
  return String(err).includes("Entity not found");
}

async function adoptMergedPRs(state: QaState, deps: QaDeps): Promise<void> {
  let merged: MergedPR[];
  try {
    merged = await deps.listMergedPRs();
  } catch (err) {
    deps.log(`merged PR list failed: ${err}`);
    return;
  }
  for (const pr of merged) {
    const key = prKey(pr);
    if (state.processedPRs.has(key)) continue;
    const identifier = issueFromBranch(pr.headRefName);
    if (!identifier || !deps.configFor(pr.repo)) {
      state.processedPRs.add(key);
      continue;
    }
    try {
      const fam = await deps.fetchFamily(identifier);
      const unitId = fam.parent ?? identifier;
      const unitFam = fam.parent ? await deps.fetchFamily(fam.parent) : fam;
      const existing = state.units.get(unitId);
      const unit: QaUnit = existing ?? { identifier: unitId, id: unitFam.id, phase: "waiting-children", lastPr: pr.number, prs: [] };
      unit.id = unitFam.id;
      unit.lastPr = pr.number;
      unit.repo = pr.repo;
      if (!unit.prs.includes(key)) unit.prs.push(key);
      if (unit.phase === "posted" || unit.phase === "failed") {
        unit.phase = "waiting-children";
        delete unit.mergeSha;
        delete unit.startedAt;
      }
      state.units.set(unitId, unit);
      state.processedPRs.add(key);
      deps.log(`${identifier} merged (#${pr.number}); QA unit ${unitId}`);
    } catch (err) {
      if (isMissing(err)) {
        state.processedPRs.add(key);
        deps.log(`${identifier} no longer exists in Linear; PR #${pr.number} latched and skipped`);
        continue;
      }
      deps.log(`adopt failed for ${identifier}: ${err}`);
    }
  }
}

async function childrenOf(unit: QaUnit, deps: QaDeps): Promise<{ identifier: string; state: string }[]> {
  const fam = await deps.fetchFamily(unit.identifier);
  if (fam.children.length > 0) return fam.children;
  return [{ identifier: unit.identifier, state: await deps.fetchState(unit.identifier) }];
}

async function stepWaitingChildren(unit: QaUnit, deps: QaDeps): Promise<void> {
  const children = await childrenOf(unit, deps);
  const open = children.filter((c) => !deps.clearedStates.has(c.state));
  if (open.length > 0) {
    deps.emit("qa_waiting", unit.identifier);
    deps.log(`${unit.identifier} waiting on ${open.map((c) => c.identifier).join(", ")}`);
    return;
  }
  unit.mergeSha = await deps.mergeCommit(unit.lastPr, unit.repo);
  unit.phase = "awaiting-deploy";
  deps.emit("qa_awaiting_deploy", unit.identifier);
  deps.log(`${unit.identifier} children cleared; awaiting deploy of ${unit.mergeSha.slice(0, 8)}`);
}

async function isDeployed(unit: QaUnit, cfg: { workflow: string }, deps: QaDeps): Promise<boolean> {
  if (!unit.mergeSha) return false;
  const heads = await deps.deployedHeadShas(cfg.workflow, unit.repo);
  for (const head of heads) {
    if (head === unit.mergeSha) return true;
    if (await deps.isAncestorOrEqual(unit.mergeSha, head, unit.repo)) return true;
  }
  return false;
}

async function stepAwaitingDeploy(unit: QaUnit, deps: QaDeps): Promise<void> {
  const cfg = deps.configFor(unit.repo);
  if (!cfg) {
    deps.log(`${unit.identifier} repo lost its QA config; holding`);
    return;
  }
  if (!(await isDeployed(unit, cfg, deps))) return;
  if ((await deps.activeCount()) >= deps.maxInProgress) {
    deps.log(`${unit.identifier} deployed; spawn deferred (WIP cap)`);
    return;
  }
  const children = (await childrenOf(unit, deps)).map((c) => c.identifier);
  deps.spawn(unit, children, cfg.nonprodUrl);
  unit.startedAt = deps.now();
  unit.phase = "in-session";
  deps.emit("qa_started", unit.identifier);
  deps.log(`${unit.identifier} QA session started`);
}

async function stepInSession(unit: QaUnit, deps: QaDeps): Promise<void> {
  const name = qaSessionName(unit.identifier);
  if (await deps.hasMarker(unit.id)) {
    deps.kill(name);
    unit.phase = "posted";
    deps.emit("qa_posted", unit.identifier);
    deps.log(`${unit.identifier} QA instructions posted`);
    return;
  }
  const dead = !deps.hasSession(name);
  const stale = deps.now() - (unit.startedAt ?? 0) > deps.sessionTimeoutMs;
  if (!dead && !stale) return;
  deps.kill(name);
  unit.phase = "failed";
  deps.emit("qa_failed", unit.identifier);
  deps.log(`${unit.identifier} QA session ${dead ? "died" : "timed out"} without posting`);
}

// A unit that clears one phase this tick keeps advancing (e.g. children clear
// and the deploy is already live) instead of waiting for the next heartbeat.
// A unit that just spawned stops here for the tick: the session is a detached
// process started microseconds ago, so checking hasSession immediately would
// read it as dead and fail a QA session that never got the chance to start.
async function runUnit(unit: QaUnit, deps: QaDeps): Promise<void> {
  let phase = unit.phase;
  while (true) {
    if (phase === "waiting-children") await stepWaitingChildren(unit, deps);
    else if (phase === "awaiting-deploy") await stepAwaitingDeploy(unit, deps);
    else if (phase === "in-session") await stepInSession(unit, deps);
    else return;
    if (unit.phase === phase || unit.phase === "in-session") return;
    phase = unit.phase;
  }
}

export async function qaOnce(state: QaState, deps: QaDeps): Promise<void> {
  await adoptMergedPRs(state, deps);
  for (const unit of [...state.units.values()]) {
    try {
      await runUnit(unit, deps);
    } catch (err) {
      if (isMissing(err)) {
        state.units.delete(unit.identifier);
        deps.log(`${unit.identifier} no longer exists in Linear; dropped`);
        continue;
      }
      deps.log(`qa step failed for ${unit.identifier}: ${err}`);
    }
  }
}
