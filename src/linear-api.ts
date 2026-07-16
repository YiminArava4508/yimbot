const API_URL = "https://api.linear.app/graphql";

export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
};

export type LinearContext = {
  viewerId: string;
  teamId: string;
  stateId: string;
};

async function gql<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<T> {
  const res = await fetchImpl(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Linear API ${res.status}: ${await res.text()}`);
  }
  const payload = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (payload.errors?.length) {
    throw new Error(`Linear GraphQL: ${payload.errors.map((e) => e.message).join("; ")}`);
  }
  if (!payload.data) {
    throw new Error("Linear GraphQL: response had no data");
  }
  return payload.data;
}

export async function resolveContext(
  apiKey: string,
  teamName: string,
  stateName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LinearContext> {
  type ResolveData = {
    viewer: { id: string };
    teams: {
      nodes: {
        id: string;
        name: string;
        states: { nodes: { id: string; name: string }[] };
      }[];
    };
  };
  const data = await gql<ResolveData>(
    apiKey,
    `query Resolve($teamName: String!) {
      viewer { id }
      teams(filter: { name: { eqIgnoreCase: $teamName } }) {
        nodes {
          id
          name
          states { nodes { id name } }
        }
      }
    }`,
    { teamName },
    fetchImpl,
  );

  const team = data.teams.nodes[0];
  if (!team) throw new Error(`No Linear team named "${teamName}"`);

  const state = team.states.nodes.find(
    (s) => s.name.toLowerCase() === stateName.toLowerCase(),
  );
  if (!state) throw new Error(`Team "${teamName}" has no state named "${stateName}"`);

  return { viewerId: data.viewer.id, teamId: team.id, stateId: state.id };
}

export async function fetchTriggerIssues(
  apiKey: string,
  ctx: LinearContext,
  fetchImpl: typeof fetch = fetch,
): Promise<LinearIssue[]> {
  type IssuesData = { issues: { nodes: LinearIssue[] } };
  const data = await gql<IssuesData>(
    apiKey,
    `query TriggerIssues($teamId: ID!, $stateId: ID!, $viewerId: ID!) {
      issues(
        first: 50
        filter: {
          team: { id: { eq: $teamId } }
          state: { id: { eq: $stateId } }
          assignee: { id: { eq: $viewerId } }
        }
      ) {
        nodes { id identifier title }
      }
    }`,
    { teamId: ctx.teamId, stateId: ctx.stateId, viewerId: ctx.viewerId },
    fetchImpl,
  );
  return data.issues.nodes;
}
