import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AC_COMMENT_MARKER, type AC } from "./acceptance.ts";
import { pullCodebase } from "./codebase-sync.ts";
import { scanDescription } from "./dependency.ts";
import { parseMaxEstimate } from "./claim.ts";
import { pinEventsLog } from "./events.ts";
import { envCsvSet, envOr } from "./env.ts";
import {
  addLabel,
  blockedInfo,
  checksInfo,
  ghRunner,
  humanChangesRequested,
  listMyClosedUnmergedPRs,
  listMyMergedPRs,
  listMyOpenPRs,
  mergeableInfo,
  prLabels,
  removeLabel,
  repoSlug,
  unresolvedThreadInfo,
  viewerLogin,
} from "./gh.ts";
import { judgeAcceptance, type JudgeRunner } from "./judge.ts";
import { describeLabelFilter, parseLabelFilter } from "./labels.ts";
import {
  countAssignedInState,
  fetchMarkedCommentBody,
  fetchIssueByIdentifier,
  fetchIssueStateType,
  fetchUsers,
  resolveContext,
  upsertMarkedComment,
} from "./linear-api.ts";
import { readMode } from "./mode.ts";
import { makePrLabelFilter } from "./pr-filter.ts";
import { ensureHostLinks } from "./setup.ts";
import { sessionScriptPath, startWatcher } from "./watcher.ts";

export async function startDaemon(): Promise<() => void> {
  pinEventsLog();
  const apiKey = process.env.LINEAR_API_KEY?.trim() ?? "";
  const teamName = envOr("LINEAR_TEAM_NAME", "Engineering");
  // The deploy step watches this state. Reads the new DEPLOY_STATE_NAME, falling
  // back to the legacy TRIGGER_STATE_NAME.
  const stateName = envOr("DEPLOY_STATE_NAME", envOr("TRIGGER_STATE_NAME", "In Progress"));
  const reviewStateName = envOr("REVIEW_STATE_NAME", "In Review");
  // The heartbeat: how often the central loop ticks. Reads the new
  // HEARTBEAT_INTERVAL_MINUTES, falling back to the legacy POLL_INTERVAL_MINUTES.
  const heartbeatIntervalMinutes = Number(
    envOr("HEARTBEAT_INTERVAL_MINUTES", envOr("POLL_INTERVAL_MINUTES", "3")),
  );
  const codebasePath = envOr("CODEBASE_PATH", join(homedir(), "Work/gemini"));

  // Claim step config. AUTO_CLAIM is on unless explicitly disabled with a
  // recognized off-value (false/off/no/0), so an intuitive toggle can't silently
  // leave claiming enabled. Falls back to the legacy AUTO_PICK.
  const autoClaim = !["false", "off", "no", "0"].includes(
    envOr("AUTO_CLAIM", envOr("AUTO_PICK", "true")).toLowerCase(),
  );
  const riskLabels = envOr("RISK_LABELS", "migration,infra,security,breaking")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
  // Which slice of the board this instance works. Two daemons on one Linear
  // account partition the work by running opposite filters ("bot" / "!bot").
  const labelFilter = parseLabelFilter(process.env.LABEL_FILTER);
  const todoStateName = envOr("TODO_STATE_NAME", "Todo");
  // How many of the viewer's tickets may sit In Progress before the claim step
  // stops claiming. Defaults to 3; set to 1 for the old one-at-a-time behavior.
  const maxInProgress = Number(envOr("MAX_IN_PROGRESS", "3"));
  // Inclusive estimate ceiling on claims; unset claims any size.
  const maxEstimate = parseMaxEstimate(process.env.MAX_ESTIMATE);

  // Refine step: size unestimated Backlog/Todo tickets before claim may touch
  // them. Its own label filter falls back to the worker's LABEL_FILTER, so one
  // filter serves both unless split explicitly.
  const autoRefine = !["false", "off", "no", "0"].includes(envOr("AUTO_REFINE", "true").toLowerCase());
  const refineLabelFilter = process.env.REFINE_LABEL_FILTER?.trim()
    ? parseLabelFilter(process.env.REFINE_LABEL_FILTER)
    : labelFilter;
  const maxRefining = Number(envOr("MAX_REFINING", "1"));
  if (!Number.isInteger(maxRefining) || maxRefining < 1) {
    throw new Error("MAX_REFINING must be a positive integer");
  }

  // Cleanup step: on by default, disabled with a recognized off-value. Removes a
  // worktree + session once its PR merges.
  const autoCleanup = !["false", "off", "no", "0"].includes(envOr("AUTO_CLEANUP", "true").toLowerCase());

  if (!apiKey) throw new Error("LINEAR_API_KEY is required");
  if (!Number.isInteger(maxInProgress) || maxInProgress < 1) {
    throw new Error("MAX_IN_PROGRESS must be a positive integer");
  }
  if (!Number.isFinite(heartbeatIntervalMinutes) || heartbeatIntervalMinutes <= 0) {
    throw new Error("HEARTBEAT_INTERVAL_MINUTES must be a positive number");
  }
  const reapStaleMinutes = Number(envOr("YIMBOT_FIX_REAP_STALE_MINUTES", "90"));
  if (!Number.isFinite(reapStaleMinutes) || reapStaleMinutes <= 0) {
    throw new Error("YIMBOT_FIX_REAP_STALE_MINUTES must be a positive number");
  }
  if (!existsSync(sessionScriptPath)) {
    throw new Error(`new-session.sh not found at ${sessionScriptPath}`);
  }
  if (!existsSync(codebasePath)) {
    throw new Error(`CODEBASE_PATH does not exist: ${codebasePath}`);
  }
  try {
    execFileSync("git", ["-C", codebasePath, "rev-parse", "--git-dir"], { stdio: "ignore" });
  } catch {
    throw new Error(`CODEBASE_PATH is not a git repository: ${codebasePath}`);
  }

  for (const line of ensureHostLinks()) console.log(`[yimbot] link: ${line}`);

  const progressContext = await resolveContext(apiKey, teamName, stateName);
  const reviewContext = await resolveContext(apiKey, teamName, reviewStateName);
  const todoContext = await resolveContext(apiKey, teamName, todoStateName);

  // REFINE_USERS names/emails resolve to ids once at startup; misses are logged
  // and dropped, and an empty result falls back to the viewer so a typo never
  // silently disables the step.
  let refineAssigneeIds = [progressContext.viewerId];
  const refineUserNames = envOr("REFINE_USERS", "").split(",").map((s) => s.trim()).filter(Boolean);
  if (autoRefine && refineUserNames.length > 0) {
    try {
      const users = await fetchUsers(apiKey);
      const resolved = refineUserNames.flatMap((name) => {
        const match = users.find(
          (u) => u.name.toLowerCase() === name.toLowerCase() || u.email.toLowerCase() === name.toLowerCase(),
        );
        if (!match) {
          console.log(`[yimbot] refine: no Linear user matches "${name}", skipping`);
          return [];
        }
        return [match.id];
      });
      if (resolved.length > 0) refineAssigneeIds = resolved;
    } catch (err) {
      console.log(`[yimbot] refine: user resolution failed (${err}); refining for the API key's viewer`);
    }
  }

  // Checks to drop from every CI rollup read, by CheckRun name or StatusContext
  // context (comma-separated, case-insensitive). A merge queue's own gating check
  // (e.g. Aviator's "aviator/checks") only completes once the ready label queues
  // the PR, so counting it would keep CI perpetually pending and deadlock both the
  // ready label and the CI-fix step. Empty by default (ignore nothing).
  const ignoreCheckNames = envCsvSet("IGNORE_CHECKS", "");
  const ignoreChecks = ignoreCheckNames.size ? (name: string) => ignoreCheckNames.has(name.toLowerCase()) : undefined;

  // The merge queue's "blocked" label. Aviator adds it (and removes the ready
  // label) when its combined-CI batch fails; the review step's blocked-fix kind
  // triggers on it and re-queues by removing it and re-adding the ready label.
  const blockedLabelName = envOr("BLOCKED_LABEL", "blocked");

  // Reviewer logins whose comments/reviews the bot addresses itself in
  // supervised mode; anyone else's raise the board flag and halt that PR's fix
  // work. Comma-separated, case-insensitive. Defaults to GitHub Copilot's
  // review identities.
  const trustedReviewers = envCsvSet("TRUSTED_REVIEWERS", "copilot-pull-request-reviewer,github-copilot[bot],copilot");

  // Review step: address comments on the viewer's open PRs. gh resolves the repo
  // from CODEBASE_PATH's origin; if gh is missing or that fails, the review step is
  // disabled (null) rather than crashing the daemon.
  const gh = ghRunner(codebasePath);
  // A ticket's labels don't change mid-flight, and reacting slowly to a relabel
  // is an explicit non-goal of the design, so this is decoupled from the
  // heartbeat rather than going stale (and re-fetched) every tick.
  const PR_LABEL_CACHE_TTL_MS = 60 * 60 * 1000;
  const prLabelFilter = makePrLabelFilter({
    filter: labelFilter,
    fetchLabels: async (identifier) => (await fetchIssueByIdentifier(apiKey, identifier)).labels,
    ttlMs: PR_LABEL_CACHE_TTL_MS,
    now: Date.now,
    log: (msg) => console.log(`[yimbot] ${msg}`),
  });
  let prReview:
    | {
        listOpenPRs: () => ReturnType<typeof listMyOpenPRs>;
        unresolvedInfo: (n: number) => ReturnType<typeof unresolvedThreadInfo>;
        mergeableInfo: (n: number) => ReturnType<typeof mergeableInfo>;
        checksInfo: (n: number) => ReturnType<typeof checksInfo>;
        blockedInfo: (n: number) => ReturnType<typeof blockedInfo>;
        humanChangesRequested: (n: number) => ReturnType<typeof humanChangesRequested>;
      }
    | null = null;
  try {
    const slug = await repoSlug(gh);
    const viewer = await viewerLogin(gh);
    prReview = {
      listOpenPRs: async () => prLabelFilter(await listMyOpenPRs(gh)),
      unresolvedInfo: (n) => unresolvedThreadInfo(gh, slug, n, viewer, trustedReviewers),
      mergeableInfo: (n) => mergeableInfo(gh, n),
      checksInfo: (n) => checksInfo(gh, n, ignoreChecks),
      blockedInfo: (n) => blockedInfo(gh, n, blockedLabelName),
      humanChangesRequested: (n) => humanChangesRequested(gh, n, trustedReviewers),
    };
    console.log(
      `[yimbot] review step ON: addressing PR comments + conflicts + failing CI + queue blocks in ${slug.owner}/${slug.name} as ${viewer}`,
    );
  } catch (err) {
    console.log(`[yimbot] review step OFF: gh unavailable or repo/viewer unresolved (${err})`);
  }

  // Cleanup step: tear down merged PRs' worktrees. Shares the review step's gh
  // availability signal (prReview !== null): if gh is missing, both are off.
  // Unfiltered: cleanup only tears down worktrees that exist on THIS machine, so
  // the other instance's PRs never had one here to reap. Gating this list would
  // suppress no duplicate work, only cost a Linear lookup per merged/closed PR,
  // and would leave a PR that changed slices mid-flight orphaned instead of
  // reaped.
  const cleanup =
    autoCleanup && prReview
      ? {
          codebasePath,
          listMergedPRs: () => listMyMergedPRs(gh),
          listClosedUnmergedPRs: () => listMyClosedUnmergedPRs(gh),
          listOpenPRs: () => listMyOpenPRs(gh),
          issueStateType: (identifier: string) => fetchIssueStateType(apiKey, identifier),
        }
      : null;
  console.log(
    cleanup
      ? "[yimbot] cleanup step ON: removing worktrees + sessions of merged PRs and done no-PR tickets"
      : `[yimbot] cleanup step OFF${autoCleanup ? " (gh unavailable)" : ""}`,
  );

  const autoContinue = !["false", "off", "no", "0"].includes(envOr("AUTO_CONTINUE", "true").toLowerCase());
  const maxContinuations = Number(envOr("MAX_CONTINUATIONS", "5"));
  if (!Number.isInteger(maxContinuations) || maxContinuations < 1) {
    throw new Error("MAX_CONTINUATIONS must be a positive integer");
  }
  const judgeModel = envOr("AC_JUDGE_MODEL", "");
  const execFileAsync = promisify(execFile);
  const judgeRun: JudgeRunner = async (prompt) => {
    const args = ["-p", prompt];
    if (judgeModel) args.push("--model", judgeModel);
    const { stdout } = await execFileAsync("claude", args, {
      cwd: codebasePath,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    });
    return stdout;
  };
  // On unless explicitly disabled, matching AUTO_READY_LABEL. Reuses judgeRun,
  // so AC_JUDGE_MODEL selects the model here too.
  const autoDependencyScan = !["false", "off", "no", "0"].includes(
    envOr("AUTO_DEPENDENCY_SCAN", "true").toLowerCase(),
  );
  const dependencyScan = autoDependencyScan
    ? { scan: (identifier: string, description: string) => scanDescription(judgeRun, identifier, description) }
    : null;
  console.log(
    dependencyScan
      ? "[yimbot] dependency scan ON: description-stated blockers become Linear relations"
      : "[yimbot] dependency scan OFF",
  );
  // Gated on the same gh-availability signal as review/cleanup: if gh is missing,
  // prReview is null and the advance step stays off.
  const advance =
    autoContinue && prReview
      ? {
          listMergedPRs: async () => prLabelFilter(await listMyMergedPRs(gh)),
          fetchAcComment: (issueId: string) => fetchMarkedCommentBody(apiKey, issueId, AC_COMMENT_MARKER),
          fetchDescription: async (identifier: string) => {
            const d = await fetchIssueByIdentifier(apiKey, identifier);
            return { id: d.id, description: d.description };
          },
          judge: (open: AC[]) => judgeAcceptance(judgeRun, open),
          writeAcComment: (issueId: string, body: string) => upsertMarkedComment(apiKey, issueId, AC_COMMENT_MARKER, body),
          activeCount: () => countAssignedInState(apiKey, progressContext.viewerId, stateName, labelFilter),
          maxInProgress,
          maxRounds: maxContinuations,
        }
      : null;
  console.log(
    advance
      ? "[yimbot] advance step ON: AC completeness + continuation"
      : `[yimbot] advance step OFF${autoContinue ? " (gh unavailable)" : ""}`,
  );

  // Ready step config. AUTO_READY_LABEL is on unless explicitly disabled with a
  // recognized off-value. Gated on the same gh-availability signal as
  // review/cleanup/advance (prReview !== null), reusing its PR-signal closures.
  const autoReadyLabel = !["false", "off", "no", "0"].includes(envOr("AUTO_READY_LABEL", "true").toLowerCase());
  const readyLabelName = envOr("READY_MERGE_LABEL", "ready-to-merge");
  const ready =
    autoReadyLabel && prReview
      ? {
          listOpenPRs: prReview.listOpenPRs,
          unresolvedInfo: prReview.unresolvedInfo,
          mergeableInfo: prReview.mergeableInfo,
          checksInfo: prReview.checksInfo,
          prLabels: (n: number) => prLabels(gh, n),
          addLabel: (n: number, label: string) => addLabel(gh, n, label),
          removeLabel: (n: number, label: string) => removeLabel(gh, n, label),
          label: readyLabelName,
          blockedLabel: blockedLabelName,
        }
      : null;
  console.log(
    ready
      ? `[yimbot] ready step ON: syncing "${readyLabelName}" label on clean PRs`
      : `[yimbot] ready step OFF${autoReadyLabel ? " (gh unavailable)" : ""}`,
  );

  // Blocked-by handling: defer claiming and move back In-Progress tickets whose
  // blocker has no merged PR. Gated on the same gh-availability signal as the
  // other gh-backed steps; reuses listMyMergedPRs.
  // Deliberately unfiltered: this list answers "has my blocker merged?", and a
  // blocker can live on the other instance's slice of the board. Filtering it
  // would leave a ticket blocked forever behind a merged bot PR.
  const blocked = prReview ? { listMergedPRs: () => listMyMergedPRs(gh) } : null;
  console.log(
    blocked
      ? "[yimbot] blocked-by handling ON: deferring + moving back tickets blocked by an unmerged PR"
      : "[yimbot] blocked-by handling OFF (gh unavailable)",
  );

  console.log(
    `[yimbot] watching "${teamName}": deploy on "${stateName}", ready-to-test flag on "${reviewStateName}", every ${heartbeatIntervalMinutes}m; syncing ${codebasePath}`,
  );
  console.log(
    `[yimbot] mode: ${readMode()} (toggle with 'm' on the board); trusted reviewers: [${[...trustedReviewers].join(", ")}]`,
  );
  console.log(
    autoClaim
      ? `[yimbot] auto-claim ON: from "${todoStateName}" in the active cycle, up to ${maxInProgress} in progress; skipping labels [${riskLabels.join(", ")}]${maxEstimate !== null ? `; estimates <= ${maxEstimate}` : ""}`
      : "[yimbot] auto-claim OFF",
  );
  console.log(
    autoRefine
      ? `[yimbot] refine step ON: sizing unestimated Backlog/Todo tickets for ${refineAssigneeIds.length} user(s), up to ${maxRefining} at a time`
      : "[yimbot] refine step OFF",
  );
  console.log(`[yimbot] label filter: ${describeLabelFilter(labelFilter)}`);

  const stop = startWatcher({
    apiKey,
    labelFilter,
    progressContext,
    reviewContext,
    heartbeatIntervalMinutes,
    reapStaleMs: reapStaleMinutes * 60 * 1000,
    claim: {
      autoClaim,
      riskLabels,
      labelFilter,
      maxInProgress,
      maxEstimate,
      todoContext,
      progressStateName: stateName,
    },
    refine: autoRefine
      ? { autoRefine, maxRefining, labelFilter: refineLabelFilter, assigneeIds: refineAssigneeIds }
      : null,
    prReview,
    cleanup,
    advance,
    ready,
    blocked,
    dependencyScan,
  });

  // Re-entrancy guard: a sync that runs longer than one interval must not overlap
  // with the next tick's sync.
  let syncing = false;
  const safeSync = async (): Promise<void> => {
    if (syncing) return;
    syncing = true;
    try {
      await pullCodebase(codebasePath);
    } finally {
      syncing = false;
    }
  };
  void safeSync();
  const syncTimer = setInterval(() => void safeSync(), heartbeatIntervalMinutes * 60 * 1000);

  return () => {
    clearInterval(syncTimer);
    stop();
  };
}
