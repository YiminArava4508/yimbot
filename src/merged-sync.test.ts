import assert from "node:assert/strict";
import { test } from "node:test";
import type { MergedPR, OpenPR } from "./gh.ts";
import { type MergedSyncDeps, mergedSyncOnce } from "./merged-sync.ts";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const GRACE_MS = 10 * 60_000;
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

type Setup = {
  merged?: MergedPR[];
  open?: OpenPR[];
  review?: { identifier: string }[];
  states?: Record<string, string>;
  failOn?: string[];
};

function setup(s: Setup) {
  const moved: string[] = [];
  const logs: string[] = [];
  const deps: MergedSyncDeps = {
    listMergedPRs: async () => s.merged ?? [],
    listOpenPRs: async () => s.open ?? [],
    listReviewIssues: async () => s.review ?? [],
    fetchState: async (id) => s.states?.[id] ?? "In Review",
    moveToMerged: async (id) => {
      if (s.failOn?.includes(id)) throw new Error("linear down");
      moved.push(id);
    },
    reviewStateName: "In Review",
    mergedStateName: "Merged",
    graceMs: GRACE_MS,
    now: () => NOW,
    log: (m) => logs.push(m),
  };
  return { deps, moved, logs };
}

const mergedPr = (number: number, branch: string, ago: number): MergedPR => ({
  number,
  headRefName: branch,
  mergedAt: minutesAgo(ago),
});

test("moves a review ticket whose PR merged before the grace period", async () => {
  const { deps, moved, logs } = setup({
    merged: [mergedPr(123, "eng-1-a", 30)],
    review: [{ identifier: "ENG-1" }],
  });
  await mergedSyncOnce(deps);
  assert.deepEqual(moved, ["ENG-1"]);
  assert.deepEqual(logs, ["[merged-sync] moved ENG-1 In Review -> Merged (PR #123 merged)"]);
});

test("leaves a ticket whose PR merged inside the grace period", async () => {
  const { deps, moved } = setup({
    merged: [mergedPr(1, "eng-1-a", 3)],
    review: [{ identifier: "ENG-1" }],
  });
  await mergedSyncOnce(deps);
  assert.deepEqual(moved, []);
});

test("leaves a ticket whose merged PR has no mergedAt", async () => {
  const { deps, moved } = setup({
    merged: [{ number: 1, headRefName: "eng-1-a" }],
    review: [{ identifier: "ENG-1" }],
  });
  await mergedSyncOnce(deps);
  assert.deepEqual(moved, []);
});

for (const state of ["Merged", "Deployed To Nonprod", "Ready To Release", "Done"]) {
  test(`never touches a ticket already in ${state}`, async () => {
    const { deps, moved } = setup({
      merged: [mergedPr(1, "eng-1-a", 60)],
      review: [{ identifier: "ENG-1" }],
      states: { "ENG-1": state },
    });
    await mergedSyncOnce(deps);
    assert.deepEqual(moved, []);
  });
}

test("leaves a ticket with one merged and one open PR", async () => {
  const { deps, moved } = setup({
    merged: [mergedPr(1, "eng-1-a", 60)],
    open: [{ number: 2, headRefName: "eng-1-b", isDraft: false }],
    review: [{ identifier: "ENG-1" }],
  });
  await mergedSyncOnce(deps);
  assert.deepEqual(moved, []);
});

test("leaves a ticket when one of its merged PRs is inside the grace period", async () => {
  const { deps, moved } = setup({
    merged: [mergedPr(1, "eng-1-a", 60), mergedPr(2, "eng-1-b", 2)],
    review: [{ identifier: "ENG-1" }],
  });
  await mergedSyncOnce(deps);
  assert.deepEqual(moved, []);
});

test("moves a split ticket once all its PRs have merged", async () => {
  const { deps, moved } = setup({
    merged: [mergedPr(1, "eng-1-a", 60), mergedPr(2, "eng-1-b", 45)],
    review: [{ identifier: "ENG-1" }],
  });
  await mergedSyncOnce(deps);
  assert.deepEqual(moved, ["ENG-1"]);
});

test("ignores merged PRs of tickets not in the review list (label filter)", async () => {
  const { deps, moved } = setup({
    merged: [mergedPr(1, "eng-1-a", 60), mergedPr(2, "eng-2-a", 60)],
    review: [{ identifier: "ENG-2" }],
  });
  await mergedSyncOnce(deps);
  assert.deepEqual(moved, ["ENG-2"]);
});

test("a failed move is logged and the other tickets still move", async () => {
  const { deps, moved, logs } = setup({
    merged: [mergedPr(1, "eng-1-a", 60), mergedPr(2, "eng-2-a", 60), mergedPr(3, "eng-3-a", 60)],
    review: [{ identifier: "ENG-1" }, { identifier: "ENG-2" }, { identifier: "ENG-3" }],
    failOn: ["ENG-2"],
  });
  await mergedSyncOnce(deps);
  assert.deepEqual(moved, ["ENG-1", "ENG-3"]);
  assert.ok(logs.some((l) => l.includes("ENG-2") && l.includes("linear down")));
});

test("a failed PR list stops the step without throwing", async () => {
  const { deps, moved, logs } = setup({ review: [{ identifier: "ENG-1" }] });
  deps.listMergedPRs = async () => {
    throw new Error("gh down");
  };
  await mergedSyncOnce(deps);
  assert.deepEqual(moved, []);
  assert.ok(logs.some((l) => l.includes("gh down")));
});
