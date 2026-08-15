import assert from "node:assert/strict";
import { test } from "node:test";
import { createSliceSubticket, sliceBranchName } from "./subticket.ts";

type JsonBody = Record<string, unknown>;

// Routes each GraphQL request to a canned response by matching the query text,
// recording every request body for assertions.
function routingFetch(routes: { match: RegExp; body: JsonBody }[]): {
  fetchImpl: typeof fetch;
  calls: JsonBody[];
} {
  const calls: JsonBody[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const req = JSON.parse(init.body) as { query: string };
    calls.push(req as unknown as JsonBody);
    const route = routes.find((r) => r.match.test(req.query));
    if (!route) throw new Error(`no route for query: ${req.query}`);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(route.body),
      json: async () => route.body,
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("sliceBranchName slugs the identifier and title", () => {
  assert.equal(sliceBranchName("ENG-42", "[1/3] Add API layer"), "eng-42-1-3-add-api-layer");
});

test("sliceBranchName truncates to 50 chars without a trailing dash", () => {
  const branch = sliceBranchName("ENG-42", "a".repeat(30) + " " + "b".repeat(30));
  assert.ok(branch.length <= 50);
  assert.ok(!branch.endsWith("-"));
});

test("createSliceSubticket creates the sub-issue and zeroes the parent estimate", async () => {
  const { fetchImpl, calls } = routingFetch([
    {
      match: /IssueSplitInfo/,
      body: { data: { issue: { id: "uuid-p", team: { id: "team-1" }, assignee: { id: "user-1" } } } },
    },
    {
      match: /issueCreate/,
      body: { data: { issueCreate: { success: true, issue: { id: "uuid-c", identifier: "ENG-43" } } } },
    },
    { match: /issueUpdate/, body: { data: { issueUpdate: { success: true } } } },
  ]);

  const result = await createSliceSubticket("k", "ENG-42", "[1/3] Add API layer", 2, fetchImpl);

  assert.deepEqual(result, { identifier: "ENG-43", branch: "eng-43-1-3-add-api-layer" });
  const create = calls.find((c) => /issueCreate/.test(c.query as string));
  assert.deepEqual(create?.variables, {
    input: {
      teamId: "team-1",
      parentId: "uuid-p",
      title: "[1/3] Add API layer",
      estimate: 2,
      assigneeId: "user-1",
    },
  });
  const update = calls.find((c) => /issueUpdate/.test(c.query as string));
  assert.deepEqual(update?.variables, { id: "uuid-p", estimate: 0 });
});

test("createSliceSubticket works without points and without an assignee", async () => {
  const { fetchImpl, calls } = routingFetch([
    {
      match: /IssueSplitInfo/,
      body: { data: { issue: { id: "uuid-p", team: { id: "team-1" }, assignee: null } } },
    },
    {
      match: /issueCreate/,
      body: { data: { issueCreate: { success: true, issue: { id: "uuid-c", identifier: "ENG-43" } } } },
    },
    { match: /issueUpdate/, body: { data: { issueUpdate: { success: true } } } },
  ]);

  const result = await createSliceSubticket("k", "ENG-42", "slice", undefined, fetchImpl);

  assert.equal(result.identifier, "ENG-43");
  const create = calls.find((c) => /issueCreate/.test(c.query as string));
  assert.deepEqual(create?.variables, {
    input: { teamId: "team-1", parentId: "uuid-p", title: "slice" },
  });
});
