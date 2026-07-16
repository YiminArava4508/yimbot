import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchTriggerIssues, resolveContext } from "./linear-api.ts";

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

test("fetchTriggerIssues returns issue nodes", async () => {
  const fetchImpl = fakeFetch({
    data: {
      issues: { nodes: [{ id: "i-1", identifier: "ENG-42", title: "Fix login" }] },
    },
  });
  const issues = await fetchTriggerIssues(
    "key",
    { viewerId: "u", teamId: "t", stateId: "s" },
    fetchImpl,
  );
  assert.deepEqual(issues, [{ id: "i-1", identifier: "ENG-42", title: "Fix login" }]);
});

test("GraphQL errors are surfaced", async () => {
  const fetchImpl = fakeFetch({ errors: [{ message: "bad key" }] });
  await assert.rejects(
    fetchTriggerIssues("key", { viewerId: "u", teamId: "t", stateId: "s" }, fetchImpl),
    /bad key/,
  );
});

test("HTTP errors are surfaced with status", async () => {
  const fetchImpl = fakeFetch({}, false, 401);
  await assert.rejects(
    fetchTriggerIssues("key", { viewerId: "u", teamId: "t", stateId: "s" }, fetchImpl),
    /Linear API 401/,
  );
});
