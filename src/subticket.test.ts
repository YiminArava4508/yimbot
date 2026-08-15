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
      body: {
        data: {
          issue: {
            id: "uuid-p",
            team: { id: "team-1", activeCycle: null },
            assignee: { id: "user-1" },
            labels: { nodes: [] },
          },
        },
      },
    },
    {
      match: /issueCreate/,
      body: { data: { issueCreate: { success: true, issue: { id: "uuid-c", identifier: "ENG-43" } } } },
    },
    { match: /issueUpdate/, body: { data: { issueUpdate: { success: true } } } },
  ]);

  const result = await createSliceSubticket("k", "ENG-42", "[1/3] Add API layer", { points: 2 }, fetchImpl);

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
      body: {
        data: {
          issue: {
            id: "uuid-p",
            team: { id: "team-1", activeCycle: null },
            assignee: null,
            labels: { nodes: [] },
          },
        },
      },
    },
    {
      match: /issueCreate/,
      body: { data: { issueCreate: { success: true, issue: { id: "uuid-c", identifier: "ENG-43" } } } },
    },
    { match: /issueUpdate/, body: { data: { issueUpdate: { success: true } } } },
  ]);

  const result = await createSliceSubticket("k", "ENG-42", "slice", {}, fetchImpl);

  assert.equal(result.identifier, "ENG-43");
  const create = calls.find((c) => /issueCreate/.test(c.query as string));
  assert.deepEqual(create?.variables, {
    input: { teamId: "team-1", parentId: "uuid-p", title: "slice" },
  });
});

test("createSliceSubticket --claimable places the sub-issue in Todo and the active cycle", async () => {
  const { fetchImpl, calls } = routingFetch([
    {
      match: /IssueSplitInfo/,
      body: {
        data: {
          issue: {
            id: "uuid-p",
            team: { id: "team-1", activeCycle: { id: "cyc-1" } },
            assignee: null,
            labels: { nodes: [] },
          },
        },
      },
    },
    {
      match: /TeamStates/,
      body: { data: { team: { states: { nodes: [{ id: "st-todo", name: "Todo", type: "unstarted" }] } } } },
    },
    {
      match: /issueCreate/,
      body: { data: { issueCreate: { success: true, issue: { id: "uuid-c", identifier: "ENG-43" } } } },
    },
    { match: /issueUpdate/, body: { data: { issueUpdate: { success: true } } } },
  ]);
  await createSliceSubticket("k", "ENG-42", "slice", { points: 2, claimable: true }, fetchImpl);
  const create = calls.find((c) => /issueCreate/.test(c.query as string));
  assert.deepEqual(create?.variables, {
    input: { teamId: "team-1", parentId: "uuid-p", title: "slice", estimate: 2, stateId: "st-todo", cycleId: "cyc-1" },
  });
});

test("createSliceSubticket --claimable inherits the parent's labels", async () => {
  const { fetchImpl, calls } = routingFetch([
    {
      match: /IssueSplitInfo/,
      body: {
        data: {
          issue: {
            id: "uuid-p",
            team: { id: "team-1", activeCycle: null },
            assignee: null,
            labels: { nodes: [{ id: "lab-1" }, { id: "lab-2" }] },
          },
        },
      },
    },
    {
      match: /TeamStates/,
      body: { data: { team: { states: { nodes: [{ id: "st-todo", name: "Todo", type: "unstarted" }] } } } },
    },
    {
      match: /issueCreate/,
      body: { data: { issueCreate: { success: true, issue: { id: "uuid-c", identifier: "ENG-43" } } } },
    },
    { match: /issueUpdate/, body: { data: { issueUpdate: { success: true } } } },
  ]);
  await createSliceSubticket("k", "ENG-42", "slice", { claimable: true }, fetchImpl);
  const create = calls.find((c) => /issueCreate/.test(c.query as string));
  assert.deepEqual(create?.variables, {
    input: {
      teamId: "team-1",
      parentId: "uuid-p",
      title: "slice",
      stateId: "st-todo",
      labelIds: ["lab-1", "lab-2"],
    },
  });
});

test("createSliceSubticket leaves the parent estimate alone with zeroParent false", async () => {
  const { fetchImpl, calls } = routingFetch([
    {
      match: /IssueSplitInfo/,
      body: {
        data: {
          issue: {
            id: "uuid-p",
            team: { id: "team-1", activeCycle: null },
            assignee: null,
            labels: { nodes: [] },
          },
        },
      },
    },
    {
      match: /TeamStates/,
      body: { data: { team: { states: { nodes: [{ id: "st-todo", name: "Todo", type: "unstarted" }] } } } },
    },
    {
      match: /issueCreate/,
      body: { data: { issueCreate: { success: true, issue: { id: "uuid-c", identifier: "ENG-43" } } } },
    },
  ]);
  await createSliceSubticket("k", "ENG-42", "slice", { claimable: true, zeroParent: false }, fetchImpl);
  assert.equal(calls.filter((c) => /issueUpdate/.test(c.query as string)).length, 0);
});

test("createSliceSubticket --claimable omits the cycle when the team has none active", async () => {
  const { fetchImpl, calls } = routingFetch([
    {
      match: /IssueSplitInfo/,
      body: {
        data: {
          issue: {
            id: "uuid-p",
            team: { id: "team-1", activeCycle: null },
            assignee: null,
            labels: { nodes: [] },
          },
        },
      },
    },
    {
      match: /TeamStates/,
      body: { data: { team: { states: { nodes: [{ id: "st-todo", name: "Todo", type: "unstarted" }] } } } },
    },
    {
      match: /issueCreate/,
      body: { data: { issueCreate: { success: true, issue: { id: "uuid-c", identifier: "ENG-43" } } } },
    },
    { match: /issueUpdate/, body: { data: { issueUpdate: { success: true } } } },
  ]);
  await createSliceSubticket("k", "ENG-42", "slice", { claimable: true }, fetchImpl);
  const create = calls.find((c) => /issueCreate/.test(c.query as string));
  assert.deepEqual(create?.variables, { input: { teamId: "team-1", parentId: "uuid-p", title: "slice", stateId: "st-todo" } });
});

test("createSliceSubticket --claimable throws when no state matches the todo name", async () => {
  const { fetchImpl } = routingFetch([
    {
      match: /IssueSplitInfo/,
      body: {
        data: {
          issue: {
            id: "uuid-p",
            team: { id: "team-1", activeCycle: null },
            assignee: null,
            labels: { nodes: [] },
          },
        },
      },
    },
    { match: /TeamStates/, body: { data: { team: { states: { nodes: [{ id: "s", name: "Doing", type: "started" }] } } } } },
  ]);
  await assert.rejects(
    createSliceSubticket("k", "ENG-42", "slice", { claimable: true, todoStateName: "Todo" }, fetchImpl),
    /no state named "Todo"/,
  );
});
