import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countAssignedInState,
  createBlocksRelation,
  createSubIssue,
  fetchIssueEstimate,
  fetchIssueSplitInfo,
  fetchUnestimatedIssues,
  fetchUsers,
  setIssueEstimate,
  fetchMarkedCommentBody,
  fetchCycleTodoIssues,
  fetchInProgressIssuesWithBlockers,
  fetchIssuesInState,
  fetchIssueByIdentifier,
  fetchIssueStateType,
  fetchTeamLabels,
  isMissingEntityError,
  moveIssueToState,
  resolveContext,
  upsertMarkedComment,
} from "./linear-api.ts";
import { parseLabelFilter } from "./labels.ts";

type JsonBody = Record<string, unknown>;

function fakeFetch(body: JsonBody, ok = true, status = 200): typeof fetch {
  return (async () => ({
    ok,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  })) as unknown as typeof fetch;
}

test("resolveContext resolves viewer, team, and state ids", async () => {
  const fetchImpl = fakeFetch({
    data: {
      viewer: { id: "user-1" },
      teams: {
        nodes: [
          {
            id: "team-1",
            name: "Engineering",
            states: { nodes: [{ id: "state-1", name: "In Progress" }] },
          },
        ],
      },
    },
  });
  const ctx = await resolveContext("key", "Engineering", "in progress", fetchImpl);
  assert.deepEqual(ctx, { viewerId: "user-1", teamId: "team-1", stateId: "state-1" });
});

test("resolveContext throws when team is missing", async () => {
  const fetchImpl = fakeFetch({ data: { viewer: { id: "user-1" }, teams: { nodes: [] } } });
  await assert.rejects(
    resolveContext("key", "Nonexistent", "In Progress", fetchImpl),
    /No Linear team named "Nonexistent"/,
  );
});

test("resolveContext throws when state is missing", async () => {
  const fetchImpl = fakeFetch({
    data: {
      viewer: { id: "user-1" },
      teams: {
        nodes: [{ id: "team-1", name: "Engineering", states: { nodes: [{ id: "s", name: "Done" }] } }],
      },
    },
  });
  await assert.rejects(
    resolveContext("key", "Engineering", "In Progress", fetchImpl),
    /has no state named "In Progress"/,
  );
});

test("fetchIssuesInState returns issue nodes", async () => {
  const fetchImpl = fakeFetch({
    data: {
      issues: {
        nodes: [{ id: "i-1", identifier: "ENG-42", title: "Fix login", labels: { nodes: [] } }],
      },
    },
  });
  const issues = await fetchIssuesInState(
    "key",
    { viewerId: "u", teamId: "t", stateId: "s" },
    fetchImpl,
  );
  assert.deepEqual(issues, [{ id: "i-1", identifier: "ENG-42", title: "Fix login", labels: [] }]);
});

test("GraphQL errors are surfaced", async () => {
  const fetchImpl = fakeFetch({ errors: [{ message: "bad key" }] });
  await assert.rejects(
    fetchIssuesInState("key", { viewerId: "u", teamId: "t", stateId: "s" }, fetchImpl),
    /bad key/,
  );
});

test("HTTP errors are surfaced with status", async () => {
  const fetchImpl = fakeFetch({}, false, 401);
  await assert.rejects(
    fetchIssuesInState("key", { viewerId: "u", teamId: "t", stateId: "s" }, fetchImpl),
    /Linear API 401/,
  );
});

// Records the request body so we can assert on the query/variables sent.
function capturingFetch(body: JsonBody): { fetchImpl: typeof fetch; calls: JsonBody[] } {
  const calls: JsonBody[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    calls.push(JSON.parse(init.body) as JsonBody);
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("fetchCycleTodoIssues flattens labels and returns enriched issues", async () => {
  const fetchImpl = fakeFetch({
    data: {
      issues: {
        nodes: [
          {
            id: "i-1",
            identifier: "ENG-42",
            title: "Fix login",
            description: "some body",
            priority: 2,
            sortOrder: 7.5,
            estimate: null,
            labels: { nodes: [{ name: "frontend" }, { name: "migration" }] },
            inverseRelations: { nodes: [] },
          },
        ],
      },
    },
  });
  const issues = await fetchCycleTodoIssues(
    "key",
    { viewerId: "u", teamId: "t", stateId: "s" },
    fetchImpl,
  );
  assert.deepEqual(issues, [
    {
      id: "i-1",
      identifier: "ENG-42",
      title: "Fix login",
      description: "some body",
      priority: 2,
      sortOrder: 7.5,
      estimate: null,
      labels: ["frontend", "migration"],
      blockedBy: [],
    },
  ]);
});

test("fetchCycleTodoIssues maps blockedBy from inverse blocks relations", async () => {
  const fetchImpl = fakeFetch({
    data: {
      issues: {
        nodes: [
          {
            id: "i-1",
            identifier: "ENG-42",
            title: "Fix login",
            priority: 2,
            sortOrder: 7.5,
            labels: { nodes: [] },
            inverseRelations: {
              nodes: [
                { type: "blocks", issue: { identifier: "ENG-4" } },
                { type: "related", issue: { identifier: "ENG-9" } },
              ],
            },
          },
        ],
      },
    },
  });
  const issues = await fetchCycleTodoIssues(
    "key",
    { viewerId: "u", teamId: "t", stateId: "s" },
    fetchImpl,
  );
  assert.deepEqual(issues[0].blockedBy, ["ENG-4"]);
});

test("fetchInProgressIssuesWithBlockers returns issues with blockedBy", async () => {
  const fetchImpl = fakeFetch({
    data: {
      issues: {
        nodes: [
          {
            id: "i-2",
            identifier: "ENG-5",
            title: "Wire it up",
            labels: { nodes: [] },
            inverseRelations: { nodes: [{ type: "blocks", issue: { identifier: "ENG-4" } }] },
          },
          {
            id: "i-3",
            identifier: "ENG-6",
            title: "Standalone",
            labels: { nodes: [] },
            inverseRelations: { nodes: [] },
          },
        ],
      },
    },
  });
  const issues = await fetchInProgressIssuesWithBlockers(
    "key",
    { viewerId: "u", teamId: "t", stateId: "s" },
    fetchImpl,
  );
  assert.deepEqual(issues, [
    { id: "i-2", identifier: "ENG-5", title: "Wire it up", labels: [], blockedBy: ["ENG-4"] },
    { id: "i-3", identifier: "ENG-6", title: "Standalone", labels: [], blockedBy: [] },
  ]);
});

test("fetchCycleTodoIssues filters by team, assignee, state, and the active cycle", async () => {
  const { fetchImpl, calls } = capturingFetch({ data: { issues: { nodes: [] } } });
  await fetchCycleTodoIssues("key", { viewerId: "u", teamId: "t", stateId: "s" }, fetchImpl);
  const query = calls[0].query as string;
  assert.match(query, /isActive/);
  assert.deepEqual(calls[0].variables, { teamId: "t", stateId: "s", viewerId: "u" });
});

test("countAssignedInState counts issues matched by assignee and state name only", async () => {
  const { fetchImpl, calls } = capturingFetch({
    data: {
      issues: {
        nodes: [
          { id: "1", labels: { nodes: [] } },
          { id: "2", labels: { nodes: [] } },
          { id: "3", labels: { nodes: [] } },
        ],
      },
    },
  });
  const count = await countAssignedInState("key", "user-1", "In Review", null, fetchImpl);
  assert.equal(count, 3);
  assert.deepEqual(calls[0].variables, { viewerId: "user-1", stateName: "In Review" });
  // No team filter: the query must not reference a team variable.
  assert.doesNotMatch(calls[0].query as string, /\$teamId/);
});

test("countAssignedInState counts only issues the label filter allows", async () => {
  const body = {
    data: {
      issues: {
        nodes: [
          { id: "1", labels: { nodes: [{ name: "bot" }] } },
          { id: "2", labels: { nodes: [] } },
          { id: "3", labels: { nodes: [] } },
        ],
      },
    },
  };
  assert.equal(await countAssignedInState("k", "v", "In Progress", null, fakeFetch(body)), 3);
  assert.equal(
    await countAssignedInState("k", "v", "In Progress", parseLabelFilter("bot"), fakeFetch(body)),
    1,
  );
  assert.equal(
    await countAssignedInState("k", "v", "In Progress", parseLabelFilter("!bot"), fakeFetch(body)),
    2,
  );
});

test("moveIssueToState sends an issueUpdate mutation with the new state", async () => {
  const { fetchImpl, calls } = capturingFetch({ data: { issueUpdate: { success: true } } });
  await moveIssueToState("key", "issue-1", "state-9", fetchImpl);
  assert.match(calls[0].query as string, /issueUpdate/);
  assert.deepEqual(calls[0].variables, { id: "issue-1", stateId: "state-9" });
});

test("moveIssueToState throws when the mutation reports failure", async () => {
  const fetchImpl = fakeFetch({ data: { issueUpdate: { success: false } } });
  await assert.rejects(
    moveIssueToState("key", "issue-1", "state-9", fetchImpl),
    /issueUpdate failed/,
  );
});

function fakeFetchMultiResponse(responses: unknown[]): typeof fetch {
  let i = 0;
  return (async () => ({ ok: true, json: async () => ({ data: responses[i++] }) })) as unknown as typeof fetch;
}

test("fetchIssueByIdentifier returns id + description", async () => {
  const f = fakeFetchMultiResponse([
    { issue: { id: "uuid-1", identifier: "ENG-949", description: "body", labels: { nodes: [] } } },
  ]);
  const d = await fetchIssueByIdentifier("key", "ENG-949", f);
  assert.deepEqual(d, { id: "uuid-1", identifier: "ENG-949", description: "body", labels: [] });
});

test("isMissingEntityError recognizes Linear's not-found GraphQL error", () => {
  assert.equal(isMissingEntityError(new Error("Linear GraphQL: Entity not found")), true);
});

test("isMissingEntityError returns false for other errors", () => {
  assert.equal(isMissingEntityError(new Error("Linear API 500: boom")), false);
  assert.equal(isMissingEntityError("not an Error"), false);
});

test("fetchIssueByIdentifier throws a missing-entity error when Linear reports the issue not found", async () => {
  const f = fakeFetch({ errors: [{ message: "Entity not found" }] });
  await assert.rejects(fetchIssueByIdentifier("key", "REVERT-1234", f), (err) => isMissingEntityError(err));
});

test("fetchIssueByIdentifier throws a missing-entity error when Linear returns a null issue with no error", async () => {
  const f = fakeFetchMultiResponse([{ issue: null }]);
  await assert.rejects(fetchIssueByIdentifier("key", "REVERT-1234", f), (err) => isMissingEntityError(err));
});

test("fetchIssueStateType returns the issue's workflow state type", async () => {
  const f = fakeFetchMultiResponse([{ issue: { state: { type: "completed" } } }]);
  assert.equal(await fetchIssueStateType("key", "ENG-949", f), "completed");
});

test("upsertMarkedComment updates when a marked comment exists", async () => {
  const calls: Record<string, unknown>[] = [];
  const f = (async (_url: string, init: { body: string }) => {
    const parsed = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    calls.push({ query: parsed.query, variables: parsed.variables });
    if (parsed.query.includes("comments")) {
      return { ok: true, json: async () => ({ data: { issue: { comments: { nodes: [{ id: "c1", body: "MARK old" }] } } } }) };
    }
    return { ok: true, json: async () => ({ data: { commentUpdate: { success: true } } }) };
  }) as unknown as typeof fetch;
  await upsertMarkedComment("key", "uuid-1", "MARK", "MARK new", f);
  assert.ok(calls.some((c) => String(c.query).includes("commentUpdate")));
  assert.ok(!calls.some((c) => String(c.query).includes("commentCreate")));
});

test("fetchMarkedCommentBody returns the marked comment body or empty string", async () => {
  const hit = fakeFetch({
    data: { issue: { comments: { nodes: [{ body: "aa MARK bb" }, { body: "other" }] } } },
  });
  assert.equal(await fetchMarkedCommentBody("key", "id", "MARK", hit), "aa MARK bb");
  const miss = fakeFetch({ data: { issue: { comments: { nodes: [{ body: "no match" }] } } } });
  assert.equal(await fetchMarkedCommentBody("key", "id", "MARK", miss), "");
});

test("upsertMarkedComment creates when no marked comment exists", async () => {
  const calls: string[] = [];
  const f = (async (_url: string, init: { body: string }) => {
    const parsed = JSON.parse(init.body) as { query: string };
    calls.push(parsed.query);
    if (parsed.query.includes("comments")) {
      return { ok: true, json: async () => ({ data: { issue: { comments: { nodes: [{ id: "c1", body: "unrelated" }] } } } }) };
    }
    return { ok: true, json: async () => ({ data: { commentCreate: { success: true } } }) };
  }) as unknown as typeof fetch;
  await upsertMarkedComment("key", "uuid-1", "MARK", "MARK new", f);
  assert.ok(calls.some((q) => q.includes("commentCreate")));
});

test("fetchCycleTodoIssues carries the description through", async () => {
  const fetchImpl = fakeFetch({
    data: {
      issues: {
        nodes: [
          {
            id: "i-1",
            identifier: "ENG-42",
            title: "Fix login",
            description: "blocked by ENG-41",
            priority: 2,
            sortOrder: 7.5,
            labels: { nodes: [] },
            inverseRelations: { nodes: [] },
          },
        ],
      },
    },
  });
  const issues = await fetchCycleTodoIssues("key", { viewerId: "u", teamId: "t", stateId: "s" }, fetchImpl);
  assert.equal(issues[0].description, "blocked by ENG-41");
});

test("fetchCycleTodoIssues defaults a null description to empty string", async () => {
  const fetchImpl = fakeFetch({
    data: {
      issues: {
        nodes: [
          {
            id: "i-1",
            identifier: "ENG-42",
            title: "Fix login",
            description: null,
            priority: 2,
            sortOrder: 7.5,
            labels: { nodes: [] },
            inverseRelations: { nodes: [] },
          },
        ],
      },
    },
  });
  const issues = await fetchCycleTodoIssues("key", { viewerId: "u", teamId: "t", stateId: "s" }, fetchImpl);
  assert.equal(issues[0].description, "");
});

test("createBlocksRelation sends the blocker as issueId and the blocked ticket as relatedIssueId", async () => {
  let vars: Record<string, unknown> = {};
  let query = "";
  const f = (async (_url: string, init: { body: string }) => {
    const parsed = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    query = parsed.query;
    vars = parsed.variables;
    return { ok: true, json: async () => ({ data: { issueRelationCreate: { success: true } } }) };
  }) as unknown as typeof fetch;
  await createBlocksRelation("key", "uuid-blocker", "uuid-blocked", f);
  assert.equal(vars.issueId, "uuid-blocker");
  assert.equal(vars.relatedIssueId, "uuid-blocked");
  assert.ok(query.includes("issueRelationCreate"));
  assert.ok(query.includes("type: blocks"));
});

test("createBlocksRelation throws when the mutation reports failure", async () => {
  const f = fakeFetch({ data: { issueRelationCreate: { success: false } } });
  await assert.rejects(() => createBlocksRelation("key", "uuid-blocker", "uuid-blocked", f), /issueRelationCreate failed/);
});

test("fetchIssuesInState returns each issue's label names", async () => {
  const body = {
    data: {
      issues: {
        nodes: [
          { id: "1", identifier: "ENG-1", title: "One", labels: { nodes: [{ name: "bot" }] } },
          { id: "2", identifier: "ENG-2", title: "Two", labels: { nodes: [] } },
        ],
      },
    },
  };
  const issues = await fetchIssuesInState("k", { viewerId: "u", teamId: "t", stateId: "s" }, fakeFetch(body));
  assert.deepEqual(issues.map((i) => i.labels), [["bot"], []]);
});

test("fetchInProgressIssuesWithBlockers returns label names", async () => {
  const body = {
    data: {
      issues: {
        nodes: [
          {
            id: "1",
            identifier: "ENG-1",
            title: "One",
            labels: { nodes: [{ name: "bot" }] },
            inverseRelations: { nodes: [] },
          },
        ],
      },
    },
  };
  const issues = await fetchInProgressIssuesWithBlockers(
    "k",
    { viewerId: "u", teamId: "t", stateId: "s" },
    fakeFetch(body),
  );
  assert.deepEqual(issues[0].labels, ["bot"]);
});

test("fetchIssueByIdentifier returns label names", async () => {
  const body = {
    data: {
      issue: { id: "1", identifier: "ENG-1", description: "d", labels: { nodes: [{ name: "bot" }] } },
    },
  };
  const detail = await fetchIssueByIdentifier("k", "ENG-1", fakeFetch(body));
  assert.deepEqual(detail.labels, ["bot"]);
});

test("fetchTeamLabels returns the team's label names", async () => {
  const body = { data: { team: { labels: { nodes: [{ name: "bot" }, { name: "infra" }] } } } };
  assert.deepEqual(await fetchTeamLabels("k", "t", fakeFetch(body)), ["bot", "infra"]);
});

test("fetchIssueSplitInfo returns id, teamId, and assigneeId", async () => {
  const body = {
    data: {
      issue: {
        id: "uuid-1",
        team: { id: "team-1", activeCycle: null },
        assignee: { id: "user-1" },
        labels: { nodes: [] },
      },
    },
  };
  const info = await fetchIssueSplitInfo("k", "ENG-1", fakeFetch(body));
  assert.deepEqual(info, {
    id: "uuid-1",
    teamId: "team-1",
    assigneeId: "user-1",
    activeCycleId: null,
    labelIds: [],
  });
});

test("fetchIssueSplitInfo returns a null assigneeId for unassigned issues", async () => {
  const body = {
    data: {
      issue: { id: "uuid-1", team: { id: "team-1", activeCycle: null }, assignee: null, labels: { nodes: [] } },
    },
  };
  const info = await fetchIssueSplitInfo("k", "ENG-1", fakeFetch(body));
  assert.equal(info.assigneeId, null);
});

test("fetchIssueSplitInfo returns the parent's label ids", async () => {
  const body = {
    data: {
      issue: {
        id: "uuid-1",
        team: { id: "team-1", activeCycle: null },
        assignee: null,
        labels: { nodes: [{ id: "lab-1" }, { id: "lab-2" }] },
      },
    },
  };
  const info = await fetchIssueSplitInfo("k", "ENG-1", fakeFetch(body));
  assert.deepEqual(info.labelIds, ["lab-1", "lab-2"]);
});

test("fetchIssueSplitInfo throws entity-not-found when the issue is missing", async () => {
  await assert.rejects(
    fetchIssueSplitInfo("k", "ENG-999", fakeFetch({ data: { issue: null } })),
    /Entity not found/,
  );
});

test("createSubIssue sends parentId, teamId, title, estimate, and assignee", async () => {
  const { fetchImpl, calls } = capturingFetch({
    data: { issueCreate: { success: true, issue: { id: "uuid-2", identifier: "ENG-2" } } },
  });
  const created = await createSubIssue(
    "k",
    { teamId: "team-1", parentId: "uuid-1", title: "[1/3] slice", estimate: 2, assigneeId: "user-1" },
    fetchImpl,
  );
  assert.deepEqual(created, { id: "uuid-2", identifier: "ENG-2" });
  assert.match(calls[0].query as string, /issueCreate/);
  assert.deepEqual(calls[0].variables, {
    input: {
      teamId: "team-1",
      parentId: "uuid-1",
      title: "[1/3] slice",
      estimate: 2,
      assigneeId: "user-1",
    },
  });
});

test("createSubIssue omits estimate and assignee when not given", async () => {
  const { fetchImpl, calls } = capturingFetch({
    data: { issueCreate: { success: true, issue: { id: "uuid-2", identifier: "ENG-2" } } },
  });
  await createSubIssue("k", { teamId: "team-1", parentId: "uuid-1", title: "slice" }, fetchImpl);
  assert.deepEqual(calls[0].variables, {
    input: { teamId: "team-1", parentId: "uuid-1", title: "slice" },
  });
});

test("createSubIssue throws when the mutation reports failure", async () => {
  const fetchImpl = fakeFetch({ data: { issueCreate: { success: false, issue: null } } });
  await assert.rejects(
    createSubIssue("k", { teamId: "t", parentId: "p", title: "slice" }, fetchImpl),
    /issueCreate failed/,
  );
});

test("setIssueEstimate sends an issueUpdate mutation with the estimate", async () => {
  const { fetchImpl, calls } = capturingFetch({ data: { issueUpdate: { success: true } } });
  await setIssueEstimate("k", "uuid-1", 0, fetchImpl);
  assert.match(calls[0].query as string, /issueUpdate/);
  assert.deepEqual(calls[0].variables, { id: "uuid-1", estimate: 0 });
});

test("setIssueEstimate throws when the mutation reports failure", async () => {
  const fetchImpl = fakeFetch({ data: { issueUpdate: { success: false } } });
  await assert.rejects(setIssueEstimate("k", "uuid-1", 0, fetchImpl), /issueUpdate failed/);
});

test("fetchUnestimatedIssues queries backlog+unstarted null-estimate issues for the assignees", async () => {
  const { fetchImpl, calls } = capturingFetch({
    data: { issues: { nodes: [{ id: "i-1", identifier: "ENG-9", title: "Big one", labels: { nodes: [{ name: "bot" }] } }] } },
  });
  const issues = await fetchUnestimatedIssues("k", "team-1", ["u-1", "u-2"], fetchImpl);
  assert.deepEqual(issues, [{ id: "i-1", identifier: "ENG-9", title: "Big one", labels: ["bot"] }]);
  assert.match(calls[0].query as string, /estimate: \{ null: true \}/);
  assert.match(calls[0].query as string, /state: \{ type: \{ in: \["backlog", "unstarted"\] \} \}/);
  assert.deepEqual(calls[0].variables, { teamId: "team-1", assigneeIds: ["u-1", "u-2"] });
});

test("fetchIssueEstimate returns the estimate or null", async () => {
  assert.equal(await fetchIssueEstimate("k", "ENG-9", fakeFetch({ data: { issue: { estimate: 3 } } })), 3);
  assert.equal(await fetchIssueEstimate("k", "ENG-9", fakeFetch({ data: { issue: { estimate: null } } })), null);
});

test("fetchIssueEstimate throws entity-not-found when the issue is missing", async () => {
  await assert.rejects(fetchIssueEstimate("k", "ENG-999", fakeFetch({ data: { issue: null } })), /Entity not found/);
});

test("fetchUsers returns id, name, and email", async () => {
  const body = { data: { users: { nodes: [{ id: "u-1", name: "Yimin Arava", email: "yimin@x.com" }] } } };
  assert.deepEqual(await fetchUsers("k", fakeFetch(body)), [{ id: "u-1", name: "Yimin Arava", email: "yimin@x.com" }]);
});

test("fetchIssueSplitInfo returns the team's active cycle id", async () => {
  const body = {
    data: {
      issue: {
        id: "uuid-1",
        team: { id: "team-1", activeCycle: { id: "cyc-1" } },
        assignee: null,
        labels: { nodes: [] },
      },
    },
  };
  const info = await fetchIssueSplitInfo("k", "ENG-1", fakeFetch(body));
  assert.equal(info.activeCycleId, "cyc-1");
});

test("fetchCycleTodoIssues carries the estimate through", async () => {
  const node = {
    id: "i-1", identifier: "ENG-1", title: "t", description: null, priority: 0, sortOrder: 1,
    estimate: 2, labels: { nodes: [] }, inverseRelations: { nodes: [] },
  };
  const issues = await fetchCycleTodoIssues("k", { viewerId: "u", teamId: "t", stateId: "s" }, fakeFetch({ data: { issues: { nodes: [node] } } }));
  assert.equal(issues[0].estimate, 2);
});
