import { labelFilterAllows, type LabelFilter } from "./labels.ts";

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
  // Raw Linear description, scanned at claim time for dependencies stated in prose.
  description: string;
  // Identifiers of tickets this one is blocked by (from inverse "blocks" relations).
  blockedBy: string[];
};

type InverseRelationNodes = { nodes: { type: string; issue: { identifier: string } | null }[] };

// Blocker identifiers from an issue's inverse relations: the blockers are the
// "blocks" relations where this issue is the target (relatedIssue).
function blockersFrom(inverse: InverseRelationNodes): string[] {
  return inverse.nodes.filter((r) => r.type === "blocks" && r.issue).map((r) => r.issue!.identifier);
}

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

// Linear reports a missing entity (e.g. issue(id) with no matching issue) as a
// GraphQL error with this message, which gql() surfaces as a thrown Error.
// fetchIssueByIdentifier throws the same wording for the other shape Linear
// can use: a null field with no error at all.
export function isMissingEntityError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("Entity not found");
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
export type StateIssue = LinearIssue & { labels: string[] };

export async function fetchIssuesInState(
  apiKey: string,
  ctx: LinearContext,
  fetchImpl: typeof fetch = fetch,
): Promise<StateIssue[]> {
  type Node = LinearIssue & { labels: { nodes: { name: string }[] } };
  type IssuesData = { issues: { nodes: Node[] } };
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
        nodes { id identifier title labels { nodes { name } } }
      }
    }`,
    { teamId: ctx.teamId, stateId: ctx.stateId, viewerId: ctx.viewerId },
    fetchImpl,
  );
  return data.issues.nodes.map((n) => ({
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    labels: n.labels.nodes.map((l) => l.name),
  }));
}

export type IssueWithBlockers = LinearIssue & { blockedBy: string[]; labels: string[] };

// The viewer's assigned issues in one state of the watched team, each enriched
// with the identifiers of the tickets it is blocked by. Used by the reconcile
// step to move blocked In-Progress tickets back to Todo.
export async function fetchInProgressIssuesWithBlockers(
  apiKey: string,
  ctx: LinearContext,
  fetchImpl: typeof fetch = fetch,
): Promise<IssueWithBlockers[]> {
  type Node = {
    id: string;
    identifier: string;
    title: string;
    labels: { nodes: { name: string }[] };
    inverseRelations: InverseRelationNodes;
  };
  type IssuesData = { issues: { nodes: Node[] } };
  const data = await gql<IssuesData>(
    apiKey,
    `query InProgressWithBlockers($teamId: ID!, $stateId: ID!, $viewerId: ID!) {
      issues(
        first: 50
        filter: {
          team: { id: { eq: $teamId } }
          state: { id: { eq: $stateId } }
          assignee: { id: { eq: $viewerId } }
        }
      ) {
        nodes {
          id
          identifier
          title
          labels { nodes { name } }
          inverseRelations { nodes { type issue { identifier } } }
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
    labels: n.labels.nodes.map((l) => l.name),
    blockedBy: blockersFrom(n.inverseRelations),
  }));
}

// A team's label names, for the setup wizard's LABEL_FILTER picker.
export async function fetchTeamLabels(
  apiKey: string,
  teamId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  type Data = { team: { labels: { nodes: { name: string }[] } } };
  const data = await gql<Data>(
    apiKey,
    `query TeamLabels($teamId: String!) {
      team(id: $teamId) { labels(first: 100) { nodes { name } } }
    }`,
    { teamId },
    fetchImpl,
  );
  return data.team.labels.nodes.map((l) => l.name);
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
    description: string | null;
    priority: number;
    sortOrder: number;
    labels: { nodes: { name: string }[] };
    inverseRelations: InverseRelationNodes;
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
          description
          priority
          sortOrder
          labels { nodes { name } }
          inverseRelations { nodes { type issue { identifier } } }
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
    description: n.description ?? "",
    priority: n.priority,
    sortOrder: n.sortOrder,
    labels: n.labels.nodes.map((l) => l.name),
    blockedBy: blockersFrom(n.inverseRelations),
  }));
}

// Count the viewer's assigned issues in a state matched by name, across ALL
// teams (no team filter) — the personal-capacity WIP counts. Uses the state
// name (not a team-scoped id) precisely so it spans teams.
export async function countAssignedInState(
  apiKey: string,
  viewerId: string,
  stateName: string,
  filter: LabelFilter = null,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  type IssuesData = { issues: { nodes: { id: string; labels: { nodes: { name: string }[] } }[] } };
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
        nodes { id labels { nodes { name } } }
      }
    }`,
    { viewerId, stateName },
    fetchImpl,
  );
  return data.issues.nodes.filter((n) => labelFilterAllows(filter, n.labels.nodes.map((l) => l.name))).length;
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

export type IssueDetail = { id: string; identifier: string; description: string; labels: string[] };

export async function fetchIssueByIdentifier(
  apiKey: string,
  identifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<IssueDetail> {
  type Data = {
    issue: {
      id: string;
      identifier: string;
      description: string | null;
      labels: { nodes: { name: string }[] };
    } | null;
  };
  const data = await gql<Data>(
    apiKey,
    `query IssueDetail($id: String!) {
      issue(id: $id) { id identifier description labels { nodes { name } } }
    }`,
    { id: identifier },
    fetchImpl,
  );
  if (!data.issue) {
    throw new Error(`Entity not found: no issue for identifier "${identifier}"`);
  }
  return {
    id: data.issue.id,
    identifier: data.issue.identifier,
    description: data.issue.description ?? "",
    labels: data.issue.labels.nodes.map((l) => l.name),
  };
}

export async function upsertMarkedComment(
  apiKey: string,
  issueId: string,
  marker: string,
  body: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  type ListData = { issue: { comments: { nodes: { id: string; body: string }[] } } };
  const list = await gql<ListData>(
    apiKey,
    `query IssueComments($id: String!) {
      issue(id: $id) { comments { nodes { id body } } }
    }`,
    { id: issueId },
    fetchImpl,
  );
  const existing = list.issue.comments.nodes.find((c) => c.body.includes(marker));
  if (existing) {
    type UpdateData = { commentUpdate: { success: boolean } };
    const data = await gql<UpdateData>(
      apiKey,
      `mutation UpdateComment($id: String!, $body: String!) {
        commentUpdate(id: $id, input: { body: $body }) { success }
      }`,
      { id: existing.id, body },
      fetchImpl,
    );
    if (!data.commentUpdate.success) throw new Error(`commentUpdate failed for ${existing.id}`);
    return;
  }
  type CreateData = { commentCreate: { success: boolean } };
  const data = await gql<CreateData>(
    apiKey,
    `mutation CreateComment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success }
    }`,
    { issueId, body },
    fetchImpl,
  );
  if (!data.commentCreate.success) throw new Error(`commentCreate failed for ${issueId}`);
}

export async function fetchMarkedCommentBody(
  apiKey: string,
  issueId: string,
  marker: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  type Data = { issue: { comments: { nodes: { body: string }[] } } };
  const data = await gql<Data>(
    apiKey,
    `query IssueAcComment($id: String!) {
      issue(id: $id) { comments { nodes { body } } }
    }`,
    { id: issueId },
    fetchImpl,
  );
  const found = data.issue.comments.nodes.find((c) => c.body.includes(marker));
  return found ? found.body : "";
}

// Record "blocked is blocked by blocker". Linear stores this as the blocker
// issue holding a "blocks" relation toward the blocked issue, which is the
// direction blockersFrom reads back out of inverseRelations.
export async function createBlocksRelation(
  apiKey: string,
  blockerId: string,
  blockedId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  type Data = { issueRelationCreate: { success: boolean } };
  const data = await gql<Data>(
    apiKey,
    `mutation CreateBlocksRelation($issueId: String!, $relatedIssueId: String!) {
      issueRelationCreate(input: { issueId: $issueId, relatedIssueId: $relatedIssueId, type: blocks }) {
        success
      }
    }`,
    { issueId: blockerId, relatedIssueId: blockedId },
    fetchImpl,
  );
  if (!data.issueRelationCreate.success) {
    throw new Error(`issueRelationCreate failed: ${blockerId} blocks ${blockedId}`);
  }
}
