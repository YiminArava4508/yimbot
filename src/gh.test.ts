import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type GhRunner,
  listMyMergedPRs,
  listMyOpenPRs,
  parseMergedPRs,
  parseOpenPRs,
  parseUnresolvedCount,
  repoSlug,
  unresolvedThreadCount,
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

test("parseUnresolvedCount counts only unresolved threads", () => {
  const json = JSON.stringify({
    data: {
      repository: {
        pullRequest: { reviewThreads: { nodes: [{ isResolved: true }, { isResolved: false }, { isResolved: false }] } },
      },
    },
  });
  assert.equal(parseUnresolvedCount(json), 2);
});

test("unresolvedThreadCount passes owner/name/number as graphql fields", async () => {
  const { run, calls } = capturingRunner([
    JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }),
  ]);
  const count = await unresolvedThreadCount(run, { owner: "o", name: "n" }, 42);
  assert.equal(count, 0);
  assert.ok(calls[0].includes("owner=o"));
  assert.ok(calls[0].includes("name=n"));
  assert.ok(calls[0].includes("number=42"));
});
