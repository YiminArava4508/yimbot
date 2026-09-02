import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addLabel,
  applyReadyLabel,
  blockedInfo,
  checksInfo,
  type GhRunner,
  listMyClosedUnmergedPRs,
  listMyMergedPRs,
  listMyOpenPRs,
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
  parseOpenPRs,
  prDiff,
  prIsDraft,
  prLabels,
  parsePrState,
  prState,
  parsePrReviewMeta,
  prReviewMeta,
  removeLabel,
  repoLabelExists,
  repoSlug,
  humanChangesRequested,
  parseHumanChangesRequested,
  parseUnresolvedInfo,
  parseViewerLogin,
  unresolvedThreadInfo,
  viewerLogin,
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

test("parseMergedPRs keeps only number/headRefName", () => {
  const prs = parseMergedPRs(
    JSON.stringify([{ number: 4700, headRefName: "eng-900-y", state: "MERGED", title: "ignored" }]),
  );
  assert.deepEqual(prs, [{ number: 4700, headRefName: "eng-900-y" }]);
});

test("listMyMergedPRs requests author=@me merged PRs and parses them", async () => {
  const { run, calls } = capturingRunner([
    JSON.stringify([{ number: 2, headRefName: "eng-2-b" }]),
  ]);
  const prs = await listMyMergedPRs(run);
  assert.deepEqual(prs, [{ number: 2, headRefName: "eng-2-b" }]);
  assert.deepEqual(calls[0].slice(0, 6), ["pr", "list", "--author", "@me", "--state", "merged"]);
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

test("parseChecksInfo treats an unfinished check as pending, even alongside a failure", () => {
  const json = rollupJson("sha3", [checkRun("COMPLETED", "FAILURE", "a"), checkRun("IN_PROGRESS", null, "b")]);
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

test("prLabels requests the labels field and parses names", async () => {
  const { run, calls } = capturingRunner([JSON.stringify({ labels: [{ name: "ready-to-merge" }] })]);
  assert.deepEqual(await prLabels(run, 4706), ["ready-to-merge"]);
  assert.deepEqual(calls[0], ["pr", "view", "4706", "--json", "labels"]);
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

test("parsePrReviewMeta maps title, body, isDraft, headRefOid and diffstat", () => {
  const meta = parsePrReviewMeta(
    JSON.stringify({ title: "t", body: "b", isDraft: true, headRefOid: "abc", additions: 10, deletions: 3 }),
  );
  assert.deepEqual(meta, { title: "t", body: "b", isDraft: true, headSha: "abc", additions: 10, deletions: 3 });
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
  assert.deepEqual(meta, { title: "t", body: "b", isDraft: false, headSha: "abc", additions: 1, deletions: 2 });
  assert.deepEqual(calls, [["pr", "view", "7", "--json", "title,body,isDraft,headRefOid,additions,deletions"]]);
});

test("parsePrState reads the labels and the draft flag from one view", () => {
  assert.deepEqual(
    parsePrState(JSON.stringify({ labels: [{ name: "ready-to-merge" }], isDraft: true })),
    { labels: ["ready-to-merge"], isDraft: true },
  );
  assert.deepEqual(parsePrState(JSON.stringify({ isDraft: false })), { labels: [], isDraft: false });
});

test("prState asks for both fields in a single call", async () => {
  const { run, calls } = capturingRunner([JSON.stringify({ labels: [], isDraft: false })]);
  await prState(run, 4706);
  assert.deepEqual(calls[0], ["pr", "view", "4706", "--json", "labels,isDraft"]);
});
