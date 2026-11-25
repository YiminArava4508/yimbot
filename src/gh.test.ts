import assert from "node:assert/strict";
import { NO_MASTER_ACCESS } from "./master.ts";
import { test } from "node:test";
import {
  parseBlockReason,
  parsePrFiles,
  parsePrLifecycle,
  parseHolderNote,
  holderNote,
  prLifecycle,
  parseQueuedPrs,
  addLabel,
  applyReadyLabel,
  blockedInfo,
  checksInfo,
  compareStatus,
  defaultBranch,
  type GhRunner,
  ghRunner,
  listMyClosedUnmergedPRs,
  listMergedPRsBy,
  listMyMergedPRs,
  listMyOpenPRs,
  listSuccessfulRunHeadShas,
  countOpenSelfImprovePrs,
  prNumberForBranch,
  markPrReadyForReview,
  mergeableInfo,
  parseBlockedInfo,
  parseChecksInfo,
  parseIsDraft,
  parseLabelNames,
  parseLabels,
  parseMergeableInfo,
  parseClosedUnmergedPRs,
  parseMergedPRs,
  parseMergeCommit,
  parseOpenPRs,
  parseRunHeadShas,
  prDiff,
  prIsDraft,
  parsePrState,
  prMergeCommit,
  prState,
  parsePrReviewMeta,
  prReviewMeta,
  removeLabel,
  repoLabelExists,
  repoMergesManually,
  repoSlug,
  humanChangesRequested,
  parseHumanChangesRequested,
  parseUnresolvedInfo,
  parseViewerLogin,
  parseViewerPermission,
  fetchMasterAccess,
  unresolvedThreadInfo,
  viewerLogin,
  parseYimbotPrs,
  listYimbotPrs,
  markPrReady,
  squashMergePr,
  commentOnPr,
} from "./gh.ts";

// Records the args each gh call received so we can assert on them.
function capturingRunner(byCall: string[]): { run: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const run: GhRunner = async (args) => {
    calls.push(args);
    return byCall[i++] ?? "";
  };
  return { run, calls };
}

test("parseOpenPRs keeps only number/headRefName/isDraft", () => {
  const prs = parseOpenPRs(
    JSON.stringify([{ number: 4706, headRefName: "eng-948-x", isDraft: false, title: "ignored" }]),
  );
  assert.deepEqual(prs, [{ number: 4706, headRefName: "eng-948-x", isDraft: false }]);
});

test("listMyOpenPRs requests author=@me open PRs and parses them", async () => {
  const { run, calls } = capturingRunner([
    JSON.stringify([{ number: 1, headRefName: "eng-1-a", isDraft: true }]),
  ]);
  const prs = await listMyOpenPRs(run);
  assert.deepEqual(prs, [{ number: 1, headRefName: "eng-1-a", isDraft: true }]);
  assert.deepEqual(calls[0].slice(0, 6), ["pr", "list", "--author", "@me", "--state", "open"]);
});

test("listMyOpenPRs tags rows with the repo it was asked about", async () => {
  const { run } = capturingRunner([JSON.stringify([{ number: 3, headRefName: "eng-3-a", isDraft: true }])]);
  const prs = await listMyOpenPRs(run, "acme/terraform-aws-platform");
  assert.deepEqual(prs, [{ number: 3, headRefName: "eng-3-a", isDraft: true, repo: "acme/terraform-aws-platform" }]);
});

test("ghRunner: an extra repo sets GH_REPO for the child, the codebase runner does not", async () => {
  const seen: (string | undefined)[] = [];
  const exec = async (_cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
    seen.push(opts.env?.GH_REPO);
    return { stdout: "" };
  };
  await ghRunner("/tmp", undefined, exec)(["pr", "list"]);
  await ghRunner("/tmp", "acme/tf", exec)(["pr", "list"]);
  assert.deepEqual(seen, [undefined, "acme/tf"]);
});

test("parseMergedPRs tags rows with the extra repo slug when given", () => {
  const json = JSON.stringify([{ number: 7, headRefName: "eng-1-x" }]);
  assert.deepEqual(parseMergedPRs(json, "acme/tf"), [{ number: 7, headRefName: "eng-1-x", repo: "acme/tf" }]);
  assert.deepEqual(parseMergedPRs(json), [{ number: 7, headRefName: "eng-1-x" }]);
});

test("parseMergedPRs keeps only number/headRefName", () => {
  const prs = parseMergedPRs(
    JSON.stringify([{ number: 4700, headRefName: "eng-900-y", state: "MERGED", title: "ignored" }]),
  );
  assert.deepEqual(prs, [{ number: 4700, headRefName: "eng-900-y" }]);
});

test("parseMergedPRs keeps mergedAt when gh returns it", () => {
  const prs = parseMergedPRs(JSON.stringify([{ number: 1, headRefName: "eng-1-a", mergedAt: "2026-11-18T10:00:00Z" }]));
  assert.deepEqual(prs, [{ number: 1, headRefName: "eng-1-a", mergedAt: "2026-11-18T10:00:00Z" }]);
});

test("listMergedPRsBy asks gh for mergedAt", async () => {
  const { run, calls } = capturingRunner(["[]"]);
  await listMergedPRsBy(run, "@me");
  assert.ok(calls[0].includes("number,headRefName,mergedAt"));
});

test("listMyMergedPRs requests author=@me merged PRs and parses them", async () => {
  const { run, calls } = capturingRunner([
    JSON.stringify([{ number: 2, headRefName: "eng-2-b" }]),
  ]);
  const prs = await listMyMergedPRs(run);
  assert.deepEqual(prs, [{ number: 2, headRefName: "eng-2-b" }]);
  assert.deepEqual(calls[0].slice(0, 6), ["pr", "list", "--author", "@me", "--state", "merged"]);
});

test("listMergedPRsBy lists merged PRs for the given author", async () => {
  const { run, calls } = capturingRunner([JSON.stringify([{ number: 7, headRefName: "eng-7-x" }])]);
  const prs = await listMergedPRsBy(run, "yimbot-red");
  assert.deepEqual(prs, [{ number: 7, headRefName: "eng-7-x" }]);
  assert.deepEqual(calls[0].slice(0, 6), ["pr", "list", "--author", "yimbot-red", "--state", "merged"]);
});

test("parseClosedUnmergedPRs drops merged rows and keeps only closed-unmerged", () => {
  const prs = parseClosedUnmergedPRs(
    JSON.stringify([
      { number: 4880, headRefName: "eng-1104-spike", mergedAt: null, state: "CLOSED" },
      { number: 4881, headRefName: "eng-950-merged", mergedAt: "2026-08-04T19:36:02Z", state: "MERGED" },
    ]),
  );
  assert.deepEqual(prs, [{ number: 4880, headRefName: "eng-1104-spike" }]);
});

test("listMyClosedUnmergedPRs requests author=@me closed PRs and filters out merged", async () => {
  const { run, calls } = capturingRunner([
    JSON.stringify([
      { number: 4880, headRefName: "eng-1104-spike", mergedAt: null },
      { number: 4881, headRefName: "eng-950-merged", mergedAt: "2026-08-04T19:36:02Z" },
    ]),
  ]);
  const prs = await listMyClosedUnmergedPRs(run);
  assert.deepEqual(prs, [{ number: 4880, headRefName: "eng-1104-spike" }]);
  assert.deepEqual(calls[0].slice(0, 6), ["pr", "list", "--author", "@me", "--state", "closed"]);
});

test("repoSlug flattens owner.login and name", async () => {
  const { run } = capturingRunner([JSON.stringify({ owner: { login: "MatthewsREIS" }, name: "gemini" })]);
  assert.deepEqual(await repoSlug(run), { owner: "MatthewsREIS", name: "gemini" });
});

function threadsJson(nodes: unknown[]): string {
  return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } });
}
function thread(isResolved: boolean, createdAt: string, login: string) {
  return { isResolved, comments: { nodes: [{ createdAt, author: { login } }] } };
}

test("parseUnresolvedInfo counts unresolved threads and finds the newest other-authored comment", () => {
  const json = threadsJson([
    thread(true, "2026-07-01T00:00:00Z", "alice"), // resolved → ignored
    thread(false, "2026-07-02T00:00:00Z", "alice"),
    thread(false, "2026-07-05T00:00:00Z", "bob"),
  ]);
  const info = parseUnresolvedInfo(json, "yimbot");
  assert.equal(info.count, 2);
  assert.equal(info.newestOtherCommentAt, Date.parse("2026-07-05T00:00:00Z"));
});

test("parseUnresolvedInfo ignores comments authored by the viewer", () => {
  const json = threadsJson([
    thread(false, "2026-07-02T00:00:00Z", "bob"),
    thread(false, "2026-07-09T00:00:00Z", "yimbot"), // viewer's own reply, newest → ignored
  ]);
  const info = parseUnresolvedInfo(json, "yimbot");
  assert.equal(info.count, 2);
  assert.equal(info.newestOtherCommentAt, Date.parse("2026-07-02T00:00:00Z"));
});

test("parseUnresolvedInfo returns null timestamp when only the viewer's comments remain", () => {
  const json = threadsJson([thread(false, "2026-07-09T00:00:00Z", "yimbot")]);
  const info = parseUnresolvedInfo(json, "yimbot");
  assert.equal(info.count, 1);
  assert.equal(info.newestOtherCommentAt, null);
});

test("parseUnresolvedInfo returns {0,null} for no threads", () => {
  assert.deepEqual(parseUnresolvedInfo(threadsJson([]), "yimbot"), {
    count: 0,
    newestOtherCommentAt: null,
    newestTrustedCommentAt: null,
    newestHumanCommentAt: null,
  });
});

test("parseUnresolvedInfo splits newest timestamps by trusted vs human authors", () => {
  const json = threadsJson([
    thread(false, "2026-07-02T00:00:00Z", "alice"),
    thread(false, "2026-07-05T00:00:00Z", "Copilot"), // trusted match is case-insensitive
    thread(false, "2026-07-03T00:00:00Z", "bob"),
  ]);
  const info = parseUnresolvedInfo(json, "yimbot", new Set(["copilot"]));
  assert.equal(info.newestOtherCommentAt, Date.parse("2026-07-05T00:00:00Z"));
  assert.equal(info.newestTrustedCommentAt, Date.parse("2026-07-05T00:00:00Z"));
  assert.equal(info.newestHumanCommentAt, Date.parse("2026-07-03T00:00:00Z"));
});

test("parseUnresolvedInfo without a trusted set treats every other author as human", () => {
  const json = threadsJson([thread(false, "2026-07-02T00:00:00Z", "copilot")]);
  const info = parseUnresolvedInfo(json, "yimbot");
  assert.equal(info.newestHumanCommentAt, Date.parse("2026-07-02T00:00:00Z"));
  assert.equal(info.newestTrustedCommentAt, null);
});

test("parseUnresolvedInfo never counts the viewer's own replies in either split", () => {
  const json = threadsJson([thread(false, "2026-07-09T00:00:00Z", "yimbot")]);
  const info = parseUnresolvedInfo(json, "yimbot", new Set(["copilot"]));
  assert.equal(info.newestTrustedCommentAt, null);
  assert.equal(info.newestHumanCommentAt, null);
});

test("unresolvedThreadInfo passes owner/name/number and parses with the viewer login", async () => {
  const run = async () => threadsJson([thread(false, "2026-07-05T00:00:00Z", "bob")]);
  const info = await unresolvedThreadInfo(run, { owner: "o", name: "n" }, 42, "yimbot");
  assert.equal(info.count, 1);
  assert.equal(info.newestOtherCommentAt, Date.parse("2026-07-05T00:00:00Z"));
});

function rollupJson(headRefOid: string, nodes: unknown[]): string {
  return JSON.stringify({ headRefOid, statusCheckRollup: nodes });
}
function checkRun(status: string, conclusion: string | null, name = "test", startedAt?: string, workflowName?: string) {
  return {
    __typename: "CheckRun",
    name,
    status,
    conclusion,
    ...(startedAt ? { startedAt } : {}),
    ...(workflowName ? { workflowName } : {}),
  };
}
function statusContext(state: string) {
  return { __typename: "StatusContext", context: "ci", state };
}

test("parseChecksInfo reports failing on a failed CheckRun conclusion", () => {
  const json = rollupJson("sha1", [checkRun("COMPLETED", "SUCCESS", "a"), checkRun("COMPLETED", "FAILURE", "b")]);
  assert.deepEqual(parseChecksInfo(json), { state: "failing", headSha: "sha1" });
});

test("parseChecksInfo reports failing on a failed StatusContext state", () => {
  const json = rollupJson("sha2", [statusContext("SUCCESS"), statusContext("ERROR")]);
  assert.deepEqual(parseChecksInfo(json), { state: "failing", headSha: "sha2" });
});

test("parseChecksInfo reports failing once any check has concluded red, even while others still run", () => {
  // A concluded failure on this head will not turn green on its own; waiting for
  // the rest of the run only delays the CI fix and lets a labeled PR read as a hold.
  const json = rollupJson("sha3", [checkRun("COMPLETED", "FAILURE", "a"), checkRun("IN_PROGRESS", null, "b")]);
  assert.equal(parseChecksInfo(json).state, "failing");
});

test("parseChecksInfo stays pending while checks run and none has failed", () => {
  const json = rollupJson("sha3b", [checkRun("COMPLETED", "SUCCESS", "a"), checkRun("IN_PROGRESS", null, "b")]);
  assert.equal(parseChecksInfo(json).state, "pending");
});

test("parseChecksInfo treats a PENDING StatusContext as pending", () => {
  assert.equal(parseChecksInfo(rollupJson("s", [statusContext("PENDING")])).state, "pending");
});

test("parseChecksInfo reports passing when every check succeeded", () => {
  const json = rollupJson("sha4", [checkRun("COMPLETED", "SUCCESS"), statusContext("SUCCESS")]);
  assert.equal(parseChecksInfo(json).state, "passing");
});

test("parseChecksInfo treats NEUTRAL/SKIPPED conclusions as non-failing", () => {
  const json = rollupJson("s", [checkRun("COMPLETED", "NEUTRAL", "a"), checkRun("COMPLETED", "SKIPPED", "b")]);
  assert.equal(parseChecksInfo(json).state, "passing");
});

test("parseChecksInfo reports none for an empty rollup", () => {
  assert.deepEqual(parseChecksInfo(rollupJson("sha5", [])), { state: "none", headSha: "sha5" });
});

test("parseChecksInfo dedupes reruns by name, keeping the latest by startedAt", () => {
  // A stale CANCELLED run of a check that later reran to SUCCESS must not count:
  // GitHub keys the rollup by the latest run per check, so the PR reads green.
  const json = rollupJson("sha", [
    checkRun("COMPLETED", "CANCELLED", "pr-size", "2026-08-05T00:19:35Z"),
    checkRun("COMPLETED", "SUCCESS", "pr-size", "2026-08-05T17:36:21Z"),
  ]);
  assert.equal(parseChecksInfo(json).state, "passing");
});

test("parseChecksInfo dedupes reruns by name, surfacing a latest failure", () => {
  const json = rollupJson("sha", [
    checkRun("COMPLETED", "SUCCESS", "build", "2026-08-05T00:00:00Z"),
    checkRun("COMPLETED", "FAILURE", "build", "2026-08-05T01:00:00Z"),
  ]);
  assert.equal(parseChecksInfo(json).state, "failing");
});

test("parseChecksInfo dedupes reruns by name, holding when the latest is still running", () => {
  const json = rollupJson("sha", [
    checkRun("COMPLETED", "FAILURE", "build", "2026-08-05T00:00:00Z"),
    checkRun("IN_PROGRESS", null, "build", "2026-08-05T01:00:00Z"),
  ]);
  assert.equal(parseChecksInfo(json).state, "pending");
});

test("parseChecksInfo ranks a timestampless queued rerun as the newest run (pending)", () => {
  // A freshly queued rerun reports no startedAt/completedAt; it must beat the prior
  // completed run so the still-running rerun keeps the rollup pending.
  const json = rollupJson("sha", [
    checkRun("COMPLETED", "SUCCESS", "build", "2026-08-05T00:00:00Z"),
    checkRun("QUEUED", null, "build"),
  ]);
  assert.equal(parseChecksInfo(json).state, "pending");
});

test("parseChecksInfo keys CheckRuns by workflow, so same-named jobs stay distinct", () => {
  const json = rollupJson("sha", [
    checkRun("COMPLETED", "SUCCESS", "build", "2026-08-05T00:00:00Z", "wf-a"),
    checkRun("COMPLETED", "FAILURE", "build", "2026-08-05T00:00:00Z", "wf-b"),
  ]);
  assert.equal(parseChecksInfo(json).state, "failing"); // both kept, not collapsed
});

test("parseChecksInfo keys a StatusContext by context, distinct from a same-named CheckRun", () => {
  const json = rollupJson("sha", [
    statusContext("ERROR"), // context "ci"
    checkRun("COMPLETED", "SUCCESS", "ci", "2026-08-05T00:00:00Z"),
  ]);
  assert.equal(parseChecksInfo(json).state, "failing"); // ctx:ci and run:::ci don't collide
});

test("parseChecksInfo excludes checks matched by the ignore predicate", () => {
  const aviator = { __typename: "StatusContext", context: "aviator/checks", state: "PENDING" };
  const json = rollupJson("sha6", [checkRun("COMPLETED", "SUCCESS"), aviator]);
  assert.equal(parseChecksInfo(json).state, "pending"); // aviator/checks keeps it pending
  assert.equal(parseChecksInfo(json, (n) => n === "aviator/checks").state, "passing"); // excluded → green
});

test("parseChecksInfo matches the ignore predicate on a CheckRun name too", () => {
  const json = rollupJson("s", [{ __typename: "CheckRun", name: "mergequeue", status: "IN_PROGRESS", conclusion: null }]);
  assert.equal(parseChecksInfo(json, (n) => n === "mergequeue").state, "none");
});

test("parseChecksInfo reports none when the only check is ignored", () => {
  const aviator = { __typename: "StatusContext", context: "aviator/checks", state: "PENDING" };
  assert.equal(parseChecksInfo(rollupJson("s", [aviator]), (n) => n === "aviator/checks").state, "none");
});

test("checksInfo requests headRefOid + statusCheckRollup for the PR and parses them", async () => {
  const { run, calls } = capturingRunner([rollupJson("deadbeef", [checkRun("COMPLETED", "FAILURE")])]);
  assert.deepEqual(await checksInfo(run, 4706), { state: "failing", headSha: "deadbeef" });
  assert.deepEqual(calls[0], ["pr", "view", "4706", "--json", "headRefOid,statusCheckRollup"]);
});

test("checksInfo forwards the ignore predicate to the parse", async () => {
  const aviator = { __typename: "StatusContext", context: "aviator/checks", state: "PENDING" };
  const { run } = capturingRunner([rollupJson("sha", [checkRun("COMPLETED", "SUCCESS"), aviator])]);
  assert.equal((await checksInfo(run, 4706, (n) => n === "aviator/checks")).state, "passing");
});

function mergeableJson(mergeable: string, headRefOid: string): string {
  return JSON.stringify({ mergeable, headRefOid });
}

test("parseMergeableInfo reports conflicting for CONFLICTING", () => {
  assert.deepEqual(parseMergeableInfo(mergeableJson("CONFLICTING", "sha1")), {
    state: "conflicting",
    headSha: "sha1",
  });
});

test("parseMergeableInfo reports mergeable for MERGEABLE", () => {
  assert.deepEqual(parseMergeableInfo(mergeableJson("MERGEABLE", "sha2")), {
    state: "mergeable",
    headSha: "sha2",
  });
});

test("parseMergeableInfo reports unknown for UNKNOWN (GitHub still computing)", () => {
  assert.equal(parseMergeableInfo(mergeableJson("UNKNOWN", "sha3")).state, "unknown");
});

test("parseMergeableInfo reports unknown for a missing mergeable field", () => {
  assert.equal(parseMergeableInfo(JSON.stringify({ headRefOid: "sha4" })).state, "unknown");
});

test("mergeableInfo requests mergeable + headRefOid for the PR and parses them", async () => {
  const { run, calls } = capturingRunner([mergeableJson("CONFLICTING", "deadbeef")]);
  assert.deepEqual(await mergeableInfo(run, 4837), { state: "conflicting", headSha: "deadbeef" });
  assert.deepEqual(calls[0], ["pr", "view", "4837", "--json", "mergeable,headRefOid"]);
});

function blockedJson(labelNames: string[], headRefOid: string): string {
  return JSON.stringify({ labels: labelNames.map((name) => ({ name })), headRefOid });
}

test("parseBlockedInfo reports blocked when the configured label is present", () => {
  assert.deepEqual(parseBlockedInfo(blockedJson(["bug", "blocked"], "sha1"), "blocked"), {
    blocked: true,
    headSha: "sha1",
  });
});

test("parseBlockedInfo reports not blocked when the label is absent", () => {
  assert.deepEqual(parseBlockedInfo(blockedJson(["bug", "ready-to-merge"], "sha2"), "blocked"), {
    blocked: false,
    headSha: "sha2",
  });
});

test("parseBlockedInfo matches the configured label name exactly", () => {
  assert.equal(parseBlockedInfo(blockedJson(["Blocked"], "sha3"), "blocked").blocked, false);
  assert.equal(parseBlockedInfo(blockedJson(["queue-blocked"], "sha4"), "blocked").blocked, false);
});

test("parseBlockedInfo treats a missing labels field as not blocked", () => {
  assert.deepEqual(parseBlockedInfo(JSON.stringify({ headRefOid: "sha5" }), "blocked"), {
    blocked: false,
    headSha: "sha5",
  });
});

test("blockedInfo requests labels + headRefOid for the PR and parses them", async () => {
  const { run, calls } = capturingRunner([blockedJson(["blocked"], "deadbeef")]);
  assert.deepEqual(await blockedInfo(run, 4929, "blocked"), { blocked: true, headSha: "deadbeef" });
  assert.deepEqual(calls[0], ["pr", "view", "4929", "--json", "labels,headRefOid"]);
});

function latestReviewsJson(reviews: { login: string; state: string; submittedAt: string }[]): string {
  return JSON.stringify({
    latestReviews: reviews.map((r) => ({ author: { login: r.login }, state: r.state, submittedAt: r.submittedAt })),
  });
}

test("parseHumanChangesRequested reports only non-trusted CHANGES_REQUESTED reviews", () => {
  const json = latestReviewsJson([
    { login: "Copilot", state: "CHANGES_REQUESTED", submittedAt: "2026-07-01T00:00:00Z" },
    { login: "alice", state: "CHANGES_REQUESTED", submittedAt: "2026-07-02T00:00:00Z" },
    { login: "bob", state: "APPROVED", submittedAt: "2026-07-03T00:00:00Z" },
  ]);
  const info = parseHumanChangesRequested(json, new Set(["copilot"]));
  assert.equal(info.requested, true);
  assert.equal(info.latestAt, Date.parse("2026-07-02T00:00:00Z"));
});

test("parseHumanChangesRequested is false when only trusted reviewers request changes", () => {
  const json = latestReviewsJson([{ login: "copilot", state: "CHANGES_REQUESTED", submittedAt: "2026-07-01T00:00:00Z" }]);
  assert.deepEqual(parseHumanChangesRequested(json, new Set(["copilot"])), { requested: false, latestAt: null });
});

test("parseHumanChangesRequested handles empty and missing latestReviews", () => {
  assert.deepEqual(parseHumanChangesRequested(latestReviewsJson([]), new Set()), { requested: false, latestAt: null });
  assert.deepEqual(parseHumanChangesRequested(JSON.stringify({}), new Set()), { requested: false, latestAt: null });
});

test("parseHumanChangesRequested picks the newest human changes-requested timestamp", () => {
  const json = latestReviewsJson([
    { login: "alice", state: "CHANGES_REQUESTED", submittedAt: "2026-07-02T00:00:00Z" },
    { login: "bob", state: "CHANGES_REQUESTED", submittedAt: "2026-07-06T00:00:00Z" },
  ]);
  assert.equal(parseHumanChangesRequested(json, new Set()).latestAt, Date.parse("2026-07-06T00:00:00Z"));
});

test("humanChangesRequested requests latestReviews for the PR and parses it", async () => {
  const { run, calls } = capturingRunner([
    latestReviewsJson([{ login: "alice", state: "CHANGES_REQUESTED", submittedAt: "2026-07-02T00:00:00Z" }]),
  ]);
  const info = await humanChangesRequested(run, 4837, new Set(["copilot"]));
  assert.equal(info.requested, true);
  assert.deepEqual(calls[0], ["pr", "view", "4837", "--json", "latestReviews"]);
});

test("parseLabels extracts label names", () => {
  assert.deepEqual(
    parseLabels(JSON.stringify({ labels: [{ name: "bug" }, { name: "ready-to-merge" }] })),
    ["bug", "ready-to-merge"],
  );
});

test("parseLabels returns [] for a PR with no labels", () => {
  assert.deepEqual(parseLabels(JSON.stringify({ labels: [] })), []);
});

test("addLabel runs pr edit --add-label for the PR", async () => {
  const { run, calls } = capturingRunner([""]);
  await addLabel(run, 4706, "ready-to-merge");
  assert.deepEqual(calls[0], ["pr", "edit", "4706", "--add-label", "ready-to-merge"]);
});

test("removeLabel runs pr edit --remove-label for the PR", async () => {
  const { run, calls } = capturingRunner([""]);
  await removeLabel(run, 4706, "ready-to-merge");
  assert.deepEqual(calls[0], ["pr", "edit", "4706", "--remove-label", "ready-to-merge"]);
});

test("parseLabelNames extracts names from a label list", () => {
  assert.deepEqual(
    parseLabelNames(JSON.stringify([{ name: "ready-to-merge" }, { name: "ready-to-merge-later" }])),
    ["ready-to-merge", "ready-to-merge-later"],
  );
});

test("repoLabelExists searches the repo labels and exact-matches the name", async () => {
  const { run, calls } = capturingRunner([JSON.stringify([{ name: "ready-to-merge-later" }, { name: "ready-to-merge" }])]);
  assert.equal(await repoLabelExists(run, "ready-to-merge"), true);
  assert.deepEqual(calls[0], ["label", "list", "--search", "ready-to-merge", "--json", "name", "--limit", "100"]);
});

test("repoLabelExists is false when the search only fuzzy-matches", async () => {
  const { run } = capturingRunner([JSON.stringify([{ name: "ready-to-merge-later" }])]);
  assert.equal(await repoLabelExists(run, "ready-to-merge"), false);
});

test("parseIsDraft reads the draft flag", () => {
  assert.equal(parseIsDraft(JSON.stringify({ isDraft: true })), true);
  assert.equal(parseIsDraft(JSON.stringify({ isDraft: false })), false);
});

test("prIsDraft requests the isDraft field and parses it", async () => {
  const { run, calls } = capturingRunner([JSON.stringify({ isDraft: true })]);
  assert.equal(await prIsDraft(run, 4706), true);
  assert.deepEqual(calls[0], ["pr", "view", "4706", "--json", "isDraft"]);
});

test("markPrReadyForReview runs pr ready for the PR", async () => {
  const { run, calls } = capturingRunner([""]);
  await markPrReadyForReview(run, 4706);
  assert.deepEqual(calls[0], ["pr", "ready", "4706"]);
});

test("applyReadyLabel rejects with a clear error when the repo lacks the label", async () => {
  const { run, calls } = capturingRunner([JSON.stringify([])]);
  await assert.rejects(
    applyReadyLabel(run, 4706, "ready-to-merge"),
    /label 'ready-to-merge' does not exist in the repo/,
  );
  assert.equal(calls.length, 1); // stopped at the label list, no pr mutation
});

test("applyReadyLabel promotes a draft PR before labeling it", async () => {
  const { run, calls } = capturingRunner([
    JSON.stringify([{ name: "ready-to-merge" }]),
    JSON.stringify({ isDraft: true }),
    "",
    "",
  ]);
  await applyReadyLabel(run, 4706, "ready-to-merge");
  assert.deepEqual(calls[2], ["pr", "ready", "4706"]);
  assert.deepEqual(calls[3], ["pr", "edit", "4706", "--add-label", "ready-to-merge"]);
});

test("applyReadyLabel labels a non-draft PR without touching draft state", async () => {
  const { run, calls } = capturingRunner([
    JSON.stringify([{ name: "ready-to-merge" }]),
    JSON.stringify({ isDraft: false }),
    "",
  ]);
  await applyReadyLabel(run, 4706, "ready-to-merge");
  assert.deepEqual(calls[2], ["pr", "edit", "4706", "--add-label", "ready-to-merge"]);
  assert.equal(calls.length, 3);
});

test("parseViewerLogin extracts the login", () => {
  assert.equal(parseViewerLogin(JSON.stringify({ data: { viewer: { login: "yimbot" } } })), "yimbot");
});

test("viewerLogin queries the graphql viewer", async () => {
  let sawArgs: string[] = [];
  const run = async (args: string[]) => {
    sawArgs = args;
    return JSON.stringify({ data: { viewer: { login: "yimbot" } } });
  };
  assert.equal(await viewerLogin(run), "yimbot");
  assert.ok(sawArgs.includes("graphql"));
});

test("prDiff passes the PR number to gh pr diff and returns raw stdout", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    return "diff --git a/x b/x\n";
  };
  const out = await prDiff(run, 42);
  assert.equal(out, "diff --git a/x b/x\n");
  assert.deepEqual(calls, [["pr", "diff", "42"]]);
});

test("parsePrReviewMeta maps title, body, headRefOid and diffstat", () => {
  const meta = parsePrReviewMeta(
    JSON.stringify({ title: "t", body: "b", isDraft: true, headRefOid: "abc", additions: 10, deletions: 3 }),
  );
  assert.deepEqual(meta, { title: "t", body: "b", headSha: "abc", additions: 10, deletions: 3 });
});

test("parsePrReviewMeta defaults a missing body to empty", () => {
  const meta = parsePrReviewMeta(
    JSON.stringify({ title: "t", isDraft: false, headRefOid: "abc", additions: 0, deletions: 0 }),
  );
  assert.equal(meta.body, "");
});

test("prReviewMeta views the PR once with every field the review and order flows need", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    return JSON.stringify({ title: "t", body: "b", isDraft: false, headRefOid: "abc", additions: 1, deletions: 2 });
  };
  const meta = await prReviewMeta(run, 7);
  assert.deepEqual(meta, { title: "t", body: "b", headSha: "abc", additions: 1, deletions: 2 });
  assert.deepEqual(calls, [["pr", "view", "7", "--json", "title,body,headRefOid,additions,deletions"]]);
});

test("parsePrState reads the labels and the draft flag from one view", () => {
  assert.deepEqual(
    parsePrState(JSON.stringify({ labels: [{ name: "ready-to-merge" }], isDraft: true, reviewDecision: "APPROVED" })),
    { labels: ["ready-to-merge"], isDraft: true, approved: true, changesRequested: false },
  );
  assert.deepEqual(parsePrState(JSON.stringify({ isDraft: false })), { labels: [], isDraft: false, approved: false, changesRequested: false });
});

test("parsePrState treats any review decision but APPROVED as not approved", () => {
  for (const reviewDecision of ["REVIEW_REQUIRED", "CHANGES_REQUESTED", "", null]) {
    assert.equal(parsePrState(JSON.stringify({ isDraft: false, reviewDecision })).approved, false);
  }
});

test("prState asks for labels, draft flag and review decision in a single call", async () => {
  const { run, calls } = capturingRunner([JSON.stringify({ labels: [], isDraft: false })]);
  await prState(run, 4706);
  assert.deepEqual(calls[0], ["pr", "view", "4706", "--json", "labels,isDraft,reviewDecision"]);
});

test("parseRunHeadShas lists head shas in gh order", () => {
  assert.deepEqual(parseRunHeadShas('[{"headSha":"aaa"},{"headSha":"bbb"}]'), ["aaa", "bbb"]);
  assert.deepEqual(parseRunHeadShas("[]"), []);
});

test("listSuccessfulRunHeadShas asks gh for successful runs of one workflow on one branch", async () => {
  const seen: string[][] = [];
  const run: GhRunner = async (args) => {
    seen.push(args);
    return '[{"headSha":"abc"}]';
  };
  assert.deepEqual(await listSuccessfulRunHeadShas(run, "deploy-nonprod.yml", "main"), ["abc"]);
  assert.deepEqual(seen[0], [
    "run", "list", "--workflow", "deploy-nonprod.yml", "--branch", "main",
    "--status", "success", "--json", "headSha", "--limit", "30",
  ]);
});

test("parseMergeCommit reads the oid and throws when the PR has none", () => {
  assert.equal(parseMergeCommit('{"mergeCommit":{"oid":"deadbeef"}}'), "deadbeef");
  assert.throws(() => parseMergeCommit('{"mergeCommit":null}'), /no merge commit/);
});

test("prMergeCommit views the PR's merge commit", async () => {
  const seen: string[][] = [];
  const run: GhRunner = async (args) => {
    seen.push(args);
    return '{"mergeCommit":{"oid":"c0ffee"}}';
  };
  assert.equal(await prMergeCommit(run, 42), "c0ffee");
  assert.deepEqual(seen[0], ["pr", "view", "42", "--json", "mergeCommit"]);
});

test("compareStatus calls the compare API and trims the status", async () => {
  const seen: string[][] = [];
  const run: GhRunner = async (args) => {
    seen.push(args);
    return "ahead\n";
  };
  assert.equal(await compareStatus(run, { owner: "acme", name: "app" }, "base1", "head1"), "ahead");
  assert.deepEqual(seen[0], ["api", "repos/acme/app/compare/base1...head1", "--jq", ".status"]);
});

test("defaultBranch asks gh for the named repo's default branch and trims it", async () => {
  const seen: string[][] = [];
  const run: GhRunner = async (args) => {
    seen.push(args);
    return "master\n";
  };
  assert.equal(await defaultBranch(run, "acme/app"), "master");
  assert.deepEqual(seen[0], [
    "repo", "view", "acme/app", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name",
  ]);
});

test("repoMergesManually is false when the repo has an Aviator config", async () => {
  const { run, calls } = capturingRunner(["{}"]);
  assert.equal(await repoMergesManually(run, "o/r"), false);
  assert.deepEqual(calls[0], ["api", "repos/o/r/contents/.aviator/config.yml", "--silent"]);
});

test("repoMergesManually is true when the Aviator config is not found", async () => {
  const run: GhRunner = async () => {
    throw new Error("gh: Not Found (HTTP 404)");
  };
  assert.equal(await repoMergesManually(run, "o/r"), true);
});

test("repoMergesManually rethrows any other failure", async () => {
  const run: GhRunner = async () => {
    throw new Error("gh: Server Error (HTTP 502)");
  };
  await assert.rejects(repoMergesManually(run, "o/r"), /502/);
});

const AVIATOR_STATUS = `# Current Aviator status\n> Aviator will automatically update this comment.\n\nThis PR is not ready to merge (currently in state blocked): merge conflict detected, please resolve manually and requeue.\n`;
const AVIATOR_FAILURE = `This pull request failed to merge: merge conflict detected, please resolve manually and requeue. After you have resolved the problem, you should remove the \`blocked\` pull request label from this PR and then try to re-queue the PR.
Additional debug info: A merge conflict occurred while queueing this pull request. Potential conflicting pull requests:
* [8062 chore(hyperion): remove is-hyperion-financials-available flag (ENG-3766)](8062)
* [8081 Remove \`contact-acitivy-tab\` flag (code, then prod)](8081)
* [8086 Remove \`listing-marketing-performance-tab\` flag (code, then prod)](8086). 
Please resolve manually and requeue. If resolving manually does not work, you may need to wait for previous PRs in the queue to merge.`;

function comments(...c: { login: string; body: string; createdAt?: string }[]): string {
  return JSON.stringify({ comments: c.map((x) => ({ author: { login: x.login }, body: x.body, createdAt: x.createdAt ?? "2026-11-18T19:51:29Z" })) });
}

test("parseBlockReason reads the queued PRs from a merge conflict failure comment", () => {
  const json = comments({ login: "aviator-app", body: AVIATOR_STATUS }, { login: "aviator-app", body: AVIATOR_FAILURE });
  assert.deepEqual(parseBlockReason(json), { kind: "conflict", waitingOn: [8062, 8081, 8086], commentAt: "2026-11-18T19:51:29Z" });
});

test("parseBlockReason uses the newest failure comment", () => {
  const older = AVIATOR_FAILURE.replace("8062", "7000");
  const newer = AVIATOR_FAILURE.replace("8062", "9000");
  const json = comments({ login: "aviator-app", body: older }, { login: "aviator-app", body: newer });
  assert.deepEqual((parseBlockReason(json) as { waitingOn: number[] }).waitingOn, [9000, 8081, 8086]);
});

test("parseBlockReason is other for failed checks, no PR list, or a non-Aviator author", () => {
  const checks = AVIATOR_FAILURE + "\nFailed checks:\n* unit-tests";
  assert.deepEqual(parseBlockReason(comments({ login: "aviator-app", body: checks })), { kind: "other" });
  const noList = "This pull request failed to merge: merge conflict detected, please resolve manually.";
  assert.deepEqual(parseBlockReason(comments({ login: "aviator-app", body: noList })), { kind: "other" });
  assert.deepEqual(parseBlockReason(comments({ login: "someone", body: AVIATOR_FAILURE })), { kind: "other" });
  assert.deepEqual(parseBlockReason(comments({ login: "aviator-app", body: AVIATOR_STATUS })), { kind: "other" });
});

test("parsePrLifecycle maps gh states", () => {
  assert.equal(parsePrLifecycle('{"state":"MERGED"}'), "merged");
  assert.equal(parsePrLifecycle('{"state":"CLOSED"}'), "closed");
  assert.equal(parsePrLifecycle('{"state":"OPEN"}'), "open");
});

test("parsePrFiles and parseQueuedPrs read paths and head SHAs", () => {
  assert.deepEqual(parsePrFiles('{"headRefOid":"abc","files":[{"path":"a.ts"},{"path":"b.ts"}]}'), { headSha: "abc", files: ["a.ts", "b.ts"] });
  assert.deepEqual(parseQueuedPrs('[{"number":5,"headRefOid":"h","files":[{"path":"x"}]},{"number":6,"headRefOid":"i"}]'), [
    { n: 5, headSha: "h", files: ["x"] },
    { n: 6, headSha: "i", files: [] },
  ]);
});

test("parseHolderNote flags an open PR that needs approval or is blocked", () => {
  assert.equal(parseHolderNote('{"state":"OPEN","reviewDecision":"REVIEW_REQUIRED","mergeStateStatus":"BLOCKED"}'), "needs approval");
  assert.equal(parseHolderNote('{"state":"OPEN","reviewDecision":"CHANGES_REQUESTED","mergeStateStatus":"BLOCKED"}'), "changes requested");
  assert.equal(parseHolderNote('{"state":"OPEN","reviewDecision":"APPROVED","mergeStateStatus":"BLOCKED"}'), "blocked");
  assert.equal(parseHolderNote('{"state":"OPEN","reviewDecision":"APPROVED","mergeStateStatus":"CLEAN"}'), undefined);
  assert.equal(parseHolderNote('{"state":"OPEN","reviewDecision":null,"mergeStateStatus":"CLEAN"}'), undefined);
  assert.equal(parseHolderNote('{"state":"MERGED","reviewDecision":"REVIEW_REQUIRED"}'), undefined);
});

test("parsePrState reports changesRequested from the review decision", () => {
  assert.equal(parsePrState(JSON.stringify({ isDraft: false, reviewDecision: "CHANGES_REQUESTED" })).changesRequested, true);
  assert.equal(parsePrState(JSON.stringify({ isDraft: false, reviewDecision: "REVIEW_REQUIRED" })).changesRequested, false);
  assert.equal(parsePrState(JSON.stringify({ isDraft: false })).changesRequested, false);
});

test("prLifecycle reads the holder note in the same gh call", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    return '{"state":"OPEN","reviewDecision":"REVIEW_REQUIRED","mergeStateStatus":"BLOCKED"}';
  };
  assert.equal(await prLifecycle(run, 8090), "open");
  assert.equal(holderNote(8090), "needs approval");
  assert.equal(calls.length, 1);
});

test("prNumberForBranch returns the first PR number for the head branch, or null", async () => {
  const first = capturingRunner([JSON.stringify([{ number: 12 }, { number: 9 }])]);
  assert.equal(await prNumberForBranch(first.run, "chore/self-improve-a-2026-11-24"), 12);
  assert.deepEqual(first.calls[0], ["pr", "list", "--head", "chore/self-improve-a-2026-11-24", "--state", "all", "--json", "number"]);
  const none = capturingRunner(["[]"]);
  assert.equal(await prNumberForBranch(none.run, "x"), null);
});

test("countOpenSelfImprovePrs counts only chore/self-improve- branches", async () => {
  const { run, calls } = capturingRunner([
    JSON.stringify([
      { number: 1, headRefName: "chore/self-improve-dead-code-scan-2026-11-24" },
      { number: 2, headRefName: "eng-5-thing" },
      { number: 3, headRefName: "chore/self-improve-other-2026-11-25" },
    ]),
  ]);
  assert.equal(await countOpenSelfImprovePrs(run), 2);
  assert.deepEqual(calls[0], ["pr", "list", "--state", "open", "--search", "head:chore/self-improve-", "--json", "number,headRefName"]);
});

test("self-improvement lookups reject when gh fails", async () => {
  const run: GhRunner = async () => {
    throw new Error("gh down");
  };
  await assert.rejects(prNumberForBranch(run, "x"), /gh down/);
  await assert.rejects(countOpenSelfImprovePrs(run), /gh down/);
});

test("parseViewerPermission reads viewerPermission and defaults to empty", () => {
  assert.equal(parseViewerPermission('{"viewerPermission":"WRITE"}'), "WRITE");
  assert.equal(parseViewerPermission("{}"), "");
});

function accessRunner(permission: string): GhRunner {
  return async (args) => {
    if (args[0] === "repo") return JSON.stringify({ viewerPermission: permission });
    return JSON.stringify({ data: { viewer: { login: "yimbot" } } });
  };
}

test("fetchMasterAccess allows WRITE and blocks READ", async () => {
  assert.deepEqual(await fetchMasterAccess(accessRunner("WRITE")), { login: "yimbot", permission: "WRITE", canEdit: true });
  assert.deepEqual(await fetchMasterAccess(accessRunner("READ")), { login: "yimbot", permission: "READ", canEdit: false });
});

test("fetchMasterAccess fails closed when a lookup rejects", async () => {
  const run: GhRunner = async () => {
    throw new Error("gh down");
  };
  assert.deepEqual(await fetchMasterAccess(run), NO_MASTER_ACCESS);
});

test("parseYimbotPrs maps fields, lowercases author, tolerates a null author", () => {
  const prs = parseYimbotPrs(
    JSON.stringify([
      { number: 7, headRefName: "feat/x", isDraft: true, author: { login: "YimBot" }, headRefOid: "abc" },
      { number: 8, headRefName: "feat/y", isDraft: false, author: null, headRefOid: "def" },
    ]),
  );
  assert.deepEqual(prs, [
    { number: 7, headRefName: "feat/x", isDraft: true, author: "yimbot", headSha: "abc" },
    { number: 8, headRefName: "feat/y", isDraft: false, author: "", headSha: "def" },
  ]);
});

test("listYimbotPrs asks gh for open PRs with the needed fields", async () => {
  const { run, calls } = capturingRunner(["[]"]);
  assert.deepEqual(await listYimbotPrs(run), []);
  assert.deepEqual(calls[0].slice(0, 5), ["pr", "list", "--state", "open", "--json"]);
  assert.equal(calls[0][5], "number,headRefName,isDraft,author,headRefOid");
});

test("markPrReady, squashMergePr and commentOnPr pass exact gh args", async () => {
  const { run, calls } = capturingRunner([]);
  await markPrReady(run, 7);
  await squashMergePr(run, 7, "abc");
  await commentOnPr(run, 7, "hello");
  assert.deepEqual(calls, [
    ["pr", "ready", "7"],
    ["pr", "merge", "7", "--squash", "--delete-branch", "--match-head-commit", "abc"],
    ["pr", "comment", "7", "--body", "hello"],
  ]);
});
