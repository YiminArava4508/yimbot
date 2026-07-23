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

// A Todo issue in the active cycle, enriched with the fields the claim step
// needs to rank it. `priority` uses Linear's inverted scale: 0=None, 1=Urgent,
// 2=High, 3=Medium, 4=Low. `sortOrder` is the manual cycle order (lower =
// higher in the list). `labels` are label names.
export type CycleTodoIssue = LinearIssue & {
  priority: number;
  sortOrder: number;
  labels: string[];
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

export type LinearTeam = { id: string; name: string; key: string };
export type LinearState = { id: string; name: string; type: string };

// Authenticate an API key by fetching the viewer. Returns the viewer's name for
// a friendly "signed in as …" confirmation; throws (via gql) on a bad key.
export async function fetchViewer(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; name: string }> {
  type ViewerData = { viewer: { id: string; name: string } };
  const data = await gql<ViewerData>(apiKey, `query Viewer { viewer { id name } }`, {}, fetchImpl);
  return data.viewer;
}

// Teams the API key can access, for the setup wizard's team picker.
export async function fetchTeams(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LinearTeam[]> {
  type TeamsData = { teams: { nodes: LinearTeam[] } };
  const data = await gql<TeamsData>(
    apiKey,
    `query Teams { teams(first: 100) { nodes { id name key } } }`,
    {},
    fetchImpl,
  );
  return data.teams.nodes;
}

// A team's workflow states, for the setup wizard's deploy/review/todo state selectors.
// Selecting from this list guarantees the name written to .env resolves at
// daemon startup (resolveContext matches state by name).
export async function fetchTeamStates(
  apiKey: string,
  teamId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LinearState[]> {
  type StatesData = { team: { states: { nodes: LinearState[] } } };
  const data = await gql<StatesData>(
    apiKey,
    `query TeamStates($teamId: String!) {
      team(id: $teamId) { states { nodes { id name type } } }
    }`,
    { teamId },
    fetchImpl,
  );
  return data.team.states.nodes;
}

// The viewer's assigned issues in one state of the watched team. Shared by the
// deploy step (In Progress) and the review step (In Review) — both watch a
// single state, so this is deliberately state-agnostic.
export async function fetchIssuesInState(
  apiKey: string,
  ctx: LinearContext,
  fetchImpl: typeof fetch = fetch,
): Promise<LinearIssue[]> {
  type IssuesData = { issues: { nodes: LinearIssue[] } };
  const data = await gql<IssuesData>(
    apiKey,
    `query IssuesInState($teamId: ID!, $stateId: ID!, $viewerId: ID!) {
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

// The watched team's active-cycle Todo issues assigned to the viewer, enriched
// with priority, sortOrder, and label names for the claim step to rank. Scoped by
// team + assignee + state + the currently-active cycle.
export async function fetchCycleTodoIssues(
  apiKey: string,
  ctx: LinearContext,
  fetchImpl: typeof fetch = fetch,
): Promise<CycleTodoIssue[]> {
  type Node = {
    id: string;
    identifier: string;
    title: string;
    priority: number;
    sortOrder: number;
    labels: { nodes: { name: string }[] };
  };
  type IssuesData = { issues: { nodes: Node[] } };
  const data = await gql<IssuesData>(
    apiKey,
    `query CycleTodos($teamId: ID!, $stateId: ID!, $viewerId: ID!) {
      issues(
        first: 50
        filter: {
          team: { id: { eq: $teamId } }
          state: { id: { eq: $stateId } }
          assignee: { id: { eq: $viewerId } }
          cycle: { isActive: { eq: true } }
        }
      ) {
        nodes {
          id
          identifier
          title
          priority
          sortOrder
          labels { nodes { name } }
        }
      }
    }`,
    { teamId: ctx.teamId, stateId: ctx.stateId, viewerId: ctx.viewerId },
    fetchImpl,
  );
  return data.issues.nodes.map((n) => ({
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    priority: n.priority,
    sortOrder: n.sortOrder,
    labels: n.labels.nodes.map((l) => l.name),
  }));
}

// Count the viewer's assigned issues in a state matched by name, across ALL
// teams (no team filter) — the personal-capacity WIP counts. Uses the state
// name (not a team-scoped id) precisely so it spans teams.
export async function countAssignedInState(
  apiKey: string,
  viewerId: string,
  stateName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  type IssuesData = { issues: { nodes: { id: string }[] } };
  const data = await gql<IssuesData>(
    apiKey,
    `query CountAssigned($viewerId: ID!, $stateName: String!) {
      issues(
        first: 100
        filter: {
          assignee: { id: { eq: $viewerId } }
          state: { name: { eq: $stateName } }
        }
      ) {
        nodes { id }
      }
    }`,
    { viewerId, stateName },
    fetchImpl,
  );
  return data.issues.nodes.length;
}

// Move an issue to a new workflow state. Throws if Linear reports the update
// did not succeed, so callers can retry.
export async function moveIssueToState(
  apiKey: string,
  issueId: string,
  stateId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  type UpdateData = { issueUpdate: { success: boolean } };
  const data = await gql<UpdateData>(
    apiKey,
    `mutation MoveIssue($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) {
        success
      }
    }`,
    { id: issueId, stateId },
    fetchImpl,
  );
  if (!data.issueUpdate.success) {
    throw new Error(`issueUpdate failed for ${issueId}`);
  }
}
