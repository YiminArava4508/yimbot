import type { Blocker } from "./blocked.ts";
import { labelFilterAllows, type LabelFilter } from "./labels.ts";
import { observeReach } from "./reach.ts";
import type { Ticket } from "./ticket-format.ts";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

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
  // Tickets this one is blocked by (from inverse "blocks" relations).
  blockedBy: Blocker[];
  estimate: number | null;
  // The parent ticket when this is a sub-issue; its Linear state type tells the
  // claim step whether a split of it is in flight ("started").
  parent: { identifier: string; stateType: string } | null;
};

type RelatedIssueNode = { identifier: string; state: { name: string; type: string } };
type InverseRelationNodes = { nodes: { type: string; issue: RelatedIssueNode | null }[] };

// The GraphQL selection every blocker read shares: the identifier plus the
// workflow state that decides whether the blocker's work has landed.
const BLOCKERS_SELECTION = "inverseRelations { nodes { type issue { identifier state { name type } } } }";

// Blockers from an issue's inverse relations: the blockers are the "blocks"
// relations where this issue is the target (relatedIssue).
function blockersFrom(inverse: InverseRelationNodes): Blocker[] {
  return inverse.nodes
    .filter((r) => r.type === "blocks" && r.issue)
    .map((r) => ({
      identifier: r.issue!.identifier,
      stateName: r.issue!.state.name,
      stateType: r.issue!.state.type,
    }));
}

async function gql<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<T> {
  // Wrapped so the board can warn when Linear stops answering. The body read
  // and the reply checks are inside the wrapper too: a connection dropped after
  // the headers fails on the read, and a rejected key arrives as a 400 whose
  // GraphQL error says "not authenticated". classifyError sorts those out: a
  // 404 or an ordinary GraphQL error is the service answering, a credential
  // rejection marks it down.
  type Payload = { data?: T; errors?: { message: string }[] };
  return observeReach("linear", async () => {
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
    const payload = (await res.json()) as Payload;
    if (payload.errors?.length) {
      throw new Error(`Linear GraphQL: ${payload.errors.map((e) => e.message).join("; ")}`);
    }
    if (!payload.data) {
      throw new Error("Linear GraphQL: response had no data");
    }
    return payload.data;
  });
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
// `estimate` and `hasChildren` are the deploy step's tracker check (a decomposed
// parent: children plus a 0-point estimate); the review step ignores them.
export type StateIssue = LinearIssue & { labels: string[]; estimate: number | null; hasChildren: boolean };

export async function fetchIssuesInState(
  apiKey: string,
  ctx: LinearContext,
  fetchImpl: typeof fetch = fetch,
): Promise<StateIssue[]> {
  type Node = LinearIssue & {
    estimate: number | null;
    labels: { nodes: { name: string }[] };
    children: { nodes: { id: string }[] };
  };
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
        nodes {
          id identifier title estimate
          labels { nodes { name } }
          children(first: 1) { nodes { id } }
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
    estimate: n.estimate ?? null,
    hasChildren: n.children.nodes.length > 0,
  }));
}

export type IssueWithBlockers = LinearIssue & { blockedBy: Blocker[]; labels: string[] };

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
          ${BLOCKERS_SELECTION}
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

export type UnestimatedIssue = LinearIssue & { labels: string[] };

// The refine step's work queue: the team's unestimated Backlog/Todo tickets for
// the configured assignees. Filters by state TYPE (backlog/unstarted), not state
// name, so it spans both columns without extra config.
export async function fetchUnestimatedIssues(
  apiKey: string,
  teamId: string,
  assigneeIds: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<UnestimatedIssue[]> {
  type Node = LinearIssue & { labels: { nodes: { name: string }[] } };
  type Data = { issues: { nodes: Node[] } };
  const data = await gql<Data>(
    apiKey,
    `query UnestimatedIssues($teamId: ID!, $assigneeIds: [ID!]!) {
      issues(
        first: 50
        filter: {
          team: { id: { eq: $teamId } }
          assignee: { id: { in: $assigneeIds } }
          estimate: { null: true }
          state: { type: { in: ["backlog", "unstarted"] } }
        }
      ) {
        nodes { id identifier title labels { nodes { name } } }
      }
    }`,
    { teamId, assigneeIds },
    fetchImpl,
  );
  return data.issues.nodes.map((n) => ({
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    labels: n.labels.nodes.map((l) => l.name),
  }));
}

export async function fetchIssueEstimate(
  apiKey: string,
  identifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  type Data = { issue: { estimate: number | null } | null };
  const data = await gql<Data>(
    apiKey,
    `query IssueEstimate($id: String!) {
      issue(id: $id) { estimate }
    }`,
    { id: identifier },
    fetchImpl,
  );
  if (!data.issue) {
    throw new Error(`Entity not found: no issue for identifier "${identifier}"`);
  }
  return data.issue.estimate;
}

export type LinearUser = { id: string; name: string; email: string };

// Workspace users, for resolving REFINE_USERS names/emails to ids at startup.
export async function fetchUsers(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<LinearUser[]> {
  type Data = { users: { nodes: LinearUser[] } };
  const data = await gql<Data>(
    apiKey,
    `query Users { users(first: 100) { nodes { id name email } } }`,
    {},
    fetchImpl,
  );
  return data.users.nodes;
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
    estimate: number | null;
    labels: { nodes: { name: string }[] };
    inverseRelations: InverseRelationNodes;
    parent?: { identifier: string; state: { type: string } } | null;
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
          estimate
          labels { nodes { name } }
          ${BLOCKERS_SELECTION}
          parent { identifier state { type } }
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
    estimate: n.estimate ?? null,
    labels: n.labels.nodes.map((l) => l.name),
    blockedBy: blockersFrom(n.inverseRelations),
    parent: n.parent ? { identifier: n.parent.identifier, stateType: n.parent.state.type } : null,
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

// The workflow state of an issue: its name and Linear's type for it. The name
// matters because a team can map several states to one type -- "In Progress",
// "Merged" and "Deployed To Nonprod" are all "started" -- so the type alone
// cannot say whether the work has landed. Drives the cleanup step's gates: a
// landed ticket's worktree/session can go.
export type TicketState = { name: string; type: string };

export async function fetchIssueState(
  apiKey: string,
  identifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TicketState> {
  type Data = { issue: { state: { name: string; type: string } } };
  const data = await gql<Data>(
    apiKey,
    `query IssueState($id: String!) {
      issue(id: $id) { state { name type } }
    }`,
    { id: identifier },
    fetchImpl,
  );
  return data.issue.state;
}

// The fields needed to hang a sub-issue off an issue: its uuid, team,
// assignee (inherited by split-slice subtickets so they stay on the bot's
// board), and the team's active cycle (so slices land in the current cycle).
export type IssueSplitInfo = {
  id: string;
  teamId: string;
  assigneeId: string | null;
  activeCycleId: string | null;
  labelIds: string[];
};

export async function fetchIssueSplitInfo(
  apiKey: string,
  identifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<IssueSplitInfo> {
  type Data = {
    issue: {
      id: string;
      team: { id: string; activeCycle: { id: string } | null };
      assignee: { id: string } | null;
      labels: { nodes: { id: string }[] };
    } | null;
  };
  const data = await gql<Data>(
    apiKey,
    `query IssueSplitInfo($id: String!) {
      issue(id: $id) { id team { id activeCycle { id } } assignee { id } labels { nodes { id } } }
    }`,
    { id: identifier },
    fetchImpl,
  );
  if (!data.issue) {
    throw new Error(`Entity not found: no issue for identifier "${identifier}"`);
  }
  return {
    id: data.issue.id,
    teamId: data.issue.team.id,
    assigneeId: data.issue.assignee?.id ?? null,
    activeCycleId: data.issue.team.activeCycle?.id ?? null,
    labelIds: data.issue.labels.nodes.map((l) => l.id),
  };
}

export type SubIssueInput = {
  teamId: string;
  parentId: string;
  title: string;
  estimate?: number;
  assigneeId?: string;
  stateId?: string;
  cycleId?: string;
  labelIds?: string[];
};

export async function createSubIssue(
  apiKey: string,
  input: SubIssueInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; identifier: string }> {
  type Data = { issueCreate: { success: boolean; issue: { id: string; identifier: string } | null } };
  const data = await gql<Data>(
    apiKey,
    `mutation CreateSubIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier }
      }
    }`,
    { input },
    fetchImpl,
  );
  if (!data.issueCreate.success || !data.issueCreate.issue) {
    throw new Error(`issueCreate failed for sub-issue of ${input.parentId}`);
  }
  return { id: data.issueCreate.issue.id, identifier: data.issueCreate.issue.identifier };
}

export async function setIssueEstimate(
  apiKey: string,
  issueId: string,
  estimate: number,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  type Data = { issueUpdate: { success: boolean } };
  const data = await gql<Data>(
    apiKey,
    `mutation SetEstimate($id: String!, $estimate: Int!) {
      issueUpdate(id: $id, input: { estimate: $estimate }) { success }
    }`,
    { id: issueId, estimate },
    fetchImpl,
  );
  if (!data.issueUpdate.success) {
    throw new Error(`issueUpdate failed for ${issueId}`);
  }
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
  await createComment(apiKey, issueId, body, fetchImpl);
}

export async function createComment(
  apiKey: string,
  issueId: string,
  body: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
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

// Everything a session needs to read a ticket: what get-ticket.sh prints.
// Linear pages a bare connection at 50; 250 is its ceiling per request, and a
// ticket with more comments than that is not a realistic case.
export type FullTicket = Ticket & { id: string; teamId: string };

export async function fetchTicket(
  apiKey: string,
  identifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FullTicket> {
  type Data = {
    issue: {
      id: string;
      identifier: string;
      title: string;
      url: string;
      description: string | null;
      estimate: number | null;
      state: { name: string };
      labels: { nodes: { name: string }[] };
      parent: { identifier: string } | null;
      assignee: { name: string } | null;
      team: { id: string };
      comments: { nodes: { body: string; createdAt: string; user: { name: string } | null }[] };
    } | null;
  };
  const data = await gql<Data>(
    apiKey,
    `query Ticket($id: String!) {
      issue(id: $id) {
        id identifier title url description estimate
        state { name }
        labels { nodes { name } }
        parent { identifier }
        assignee { name }
        team { id }
        comments(first: 250) { nodes { body createdAt user { name } } }
      }
    }`,
    { id: identifier },
    fetchImpl,
  );
  const issue = data.issue;
  if (!issue) {
    throw new Error(`Entity not found: no issue for identifier "${identifier}"`);
  }
  const comments = issue.comments.nodes
    .map((c) => ({ author: c.user?.name ?? null, createdAt: c.createdAt, body: c.body }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    id: issue.id,
    teamId: issue.team.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    description: issue.description ?? "",
    estimate: issue.estimate,
    state: issue.state.name,
    labels: issue.labels.nodes.map((l) => l.name),
    parent: issue.parent?.identifier ?? null,
    assignee: issue.assignee?.name ?? null,
    comments,
  };
}

// Move an issue into the team state with this name (case-insensitive), and
// return the state's canonical name. What move-ticket.sh runs.
export async function moveIssueToStateByName(
  apiKey: string,
  identifier: string,
  stateName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  type Data = { issue: { id: string; team: { id: string } } | null };
  const data = await gql<Data>(
    apiKey,
    `query IssueTeam($id: String!) { issue(id: $id) { id team { id } } }`,
    { id: identifier },
    fetchImpl,
  );
  if (!data.issue) {
    throw new Error(`Entity not found: no issue for identifier "${identifier}"`);
  }
  const states = await fetchTeamStates(apiKey, data.issue.team.id, fetchImpl);
  const want = stateName.trim().toLowerCase();
  const state = states.find((s) => s.name.toLowerCase() === want);
  if (!state) {
    throw new Error(`no state "${stateName}" on this team; states are: ${states.map((s) => s.name).join(", ")}`);
  }
  await moveIssueToState(apiKey, data.issue.id, state.id, fetchImpl);
  return state.name;
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

export type IssueFamily = {
  id: string;
  identifier: string;
  parent: string | null;
  children: { identifier: string; state: string }[];
};

// The QA step's one read per ticket: the uuid (for marked-comment lookups),
// the parent (the QA unit), and each child's workflow state (the readiness gate).
export async function fetchIssueFamily(
  apiKey: string,
  identifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<IssueFamily> {
  type Data = {
    issue: {
      id: string;
      identifier: string;
      parent: { identifier: string } | null;
      children: { nodes: { identifier: string; state: { name: string } }[] };
    } | null;
  };
  const data = await gql<Data>(
    apiKey,
    `query IssueFamily($id: String!) {
      issue(id: $id) {
        id identifier
        parent { identifier }
        children { nodes { identifier state { name } } }
      }
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
    parent: data.issue.parent?.identifier ?? null,
    children: data.issue.children.nodes.map((c) => ({ identifier: c.identifier, state: c.state.name })),
  };
}

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
};

// Two-step Linear upload: ask for a presigned slot, PUT the bytes there with the
// headers Linear hands back, and return the asset url a comment can embed.
export async function uploadFile(
  apiKey: string,
  path: string,
  fetchImpl: typeof fetch = fetch,
  readFile: (p: string) => Buffer = (p) => readFileSync(p),
): Promise<string> {
  const bytes = readFile(path);
  const contentType = CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
  type Data = {
    fileUpload: {
      success: boolean;
      uploadFile: { uploadUrl: string; assetUrl: string; headers: { key: string; value: string }[] } | null;
    };
  };
  const data = await gql<Data>(
    apiKey,
    `mutation FileUpload($contentType: String!, $filename: String!, $size: Int!) {
      fileUpload(contentType: $contentType, filename: $filename, size: $size) {
        success
        uploadFile { uploadUrl assetUrl headers { key value } }
      }
    }`,
    { contentType, filename: basename(path), size: bytes.length },
    fetchImpl,
  );
  const slot = data.fileUpload.uploadFile;
  if (!data.fileUpload.success || !slot) throw new Error(`fileUpload failed for ${path}`);
  const headers: Record<string, string> = { "Content-Type": contentType };
  for (const h of slot.headers) headers[h.key] = h.value;
  const res = await fetchImpl(slot.uploadUrl, { method: "PUT", headers, body: bytes as unknown as BodyInit });
  if (!res.ok) throw new Error(`upload PUT ${res.status}: ${await res.text()}`);
  return slot.assetUrl;
}
