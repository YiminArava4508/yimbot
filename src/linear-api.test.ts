import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countAssignedInState,
  fetchCycleTodoIssues,
  fetchIssuesInState,
  fetchIssueByIdentifier,
  moveIssueToState,
  resolveContext,
  upsertAcComment,
} from "./linear-api.ts";

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
      issues: { nodes: [{ id: "i-1", identifier: "ENG-42", title: "Fix login" }] },
    },
  });
  const issues = await fetchIssuesInState(
    "key",
    { viewerId: "u", teamId: "t", stateId: "s" },
    fetchImpl,
  );
  assert.deepEqual(issues, [{ id: "i-1", identifier: "ENG-42", title: "Fix login" }]);
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
            priority: 2,
            sortOrder: 7.5,
            labels: { nodes: [{ name: "frontend" }, { name: "migration" }] },
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
      priority: 2,
      sortOrder: 7.5,
      labels: ["frontend", "migration"],
    },
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
    data: { issues: { nodes: [{ id: "1" }, { id: "2" }, { id: "3" }] } },
  });
  const count = await countAssignedInState("key", "user-1", "In Review", fetchImpl);
  assert.equal(count, 3);
  assert.deepEqual(calls[0].variables, { viewerId: "user-1", stateName: "In Review" });
  // No team filter: the query must not reference a team variable.
  assert.doesNotMatch(calls[0].query as string, /\$teamId/);
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
  const f = fakeFetchMultiResponse([{ issue: { id: "uuid-1", identifier: "ENG-949", description: "body" } }]);
  const d = await fetchIssueByIdentifier("key", "ENG-949", f);
  assert.deepEqual(d, { id: "uuid-1", identifier: "ENG-949", description: "body" });
});

test("upsertAcComment updates when a marked comment exists", async () => {
  const calls: Record<string, unknown>[] = [];
  const f = (async (_url: string, init: { body: string }) => {
    const parsed = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    calls.push({ query: parsed.query, variables: parsed.variables });
    if (parsed.query.includes("comments")) {
      return { ok: true, json: async () => ({ data: { issue: { comments: { nodes: [{ id: "c1", body: "MARK old" }] } } } }) };
    }
    return { ok: true, json: async () => ({ data: { commentUpdate: { success: true } } }) };
  }) as unknown as typeof fetch;
  await upsertAcComment("key", "uuid-1", "MARK", "MARK new", f);
  assert.ok(calls.some((c) => String(c.query).includes("commentUpdate")));
  assert.ok(!calls.some((c) => String(c.query).includes("commentCreate")));
});

test("upsertAcComment creates when no marked comment exists", async () => {
  const calls: string[] = [];
  const f = (async (_url: string, init: { body: string }) => {
    const parsed = JSON.parse(init.body) as { query: string };
    calls.push(parsed.query);
    if (parsed.query.includes("comments")) {
      return { ok: true, json: async () => ({ data: { issue: { comments: { nodes: [{ id: "c1", body: "unrelated" }] } } } }) };
    }
    return { ok: true, json: async () => ({ data: { commentCreate: { success: true } } }) };
  }) as unknown as typeof fetch;
  await upsertAcComment("key", "uuid-1", "MARK", "MARK new", f);
  assert.ok(calls.some((q) => q.includes("commentCreate")));
});
