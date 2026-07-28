import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type GhRunner,
  listMyMergedPRs,
  listMyOpenPRs,
  parseMergedPRs,
  parseOpenPRs,
  repoSlug,
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
  assert.deepEqual(parseUnresolvedInfo(threadsJson([]), "yimbot"), { count: 0, newestOtherCommentAt: null });
});

test("unresolvedThreadInfo passes owner/name/number and parses with the viewer login", async () => {
  const run = async () => threadsJson([thread(false, "2026-07-05T00:00:00Z", "bob")]);
  const info = await unresolvedThreadInfo(run, { owner: "o", name: "n" }, 42, "yimbot");
  assert.equal(info.count, 1);
  assert.equal(info.newestOtherCommentAt, Date.parse("2026-07-05T00:00:00Z"));
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
