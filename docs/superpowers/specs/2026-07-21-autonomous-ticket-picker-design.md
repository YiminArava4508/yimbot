# Autonomous Ticket Picker — Design

**Date:** 2026-07-21
**Status:** approved (pending spec review)

## Problem

Today the linear-helper daemon is *reactive*: it only launches work when a
human manually moves a ticket into **In Progress**. That manual move is the last
remaining hand-crank in an otherwise autonomous pipeline (In Progress → worktree
+ tmux → autonomous `pickup-ticket` → tests green → move to Review + local
server running).

We want the daemon to *also* start work on its own: find the next ready ticket
in the current cycle and begin it, with strict work-in-progress limits so it
never runs away.

## Behavior

A new **picker step** runs on the daemon's existing poll loop (every
`POLL_INTERVAL_MINUTES`, default 3). There is **no separate 15-minute
schedule** — one-at-a-time work is gated by *state*, not by a timer.

### The gate (WIP limits)

On each poll, before selecting anything, the picker checks two counts of the
viewer's assigned issues **across all teams** (these are personal-capacity
limits — they are matched by assignee + state *name*, with no team filter):

1. **In Progress count** — must be `0`. One ticket in progress at a time; the
   picker does not start new work until the current ticket has landed in Review.
2. **In Review count** — must be `< MAX_REVIEW` (default `3`). If it is `>=`
   the cap, the **pipeline stalls and logs it** (e.g.
   `[picker] review full (3/3) — pipeline stalled`) and picks nothing.

Both conditions must hold to proceed. Because a completed In-Progress ticket
becomes an In-Review ticket (and each In-Review ticket holds a running local
server via the existing In-Review resume trigger), reserving a review slot with
the `< 3` check guarantees the invariant: **In Progress ≤ 1, In Review ≤ 3** —
at most 4 active sessions/servers, review cap never exceeded.

These counts are **viewer-wide and not cycle-scoped**: any ticket assigned to
you that is In Progress or In Review counts — whatever team or cycle it belongs
to — because it reflects work you're personally holding (and, for reviews, a
running local server). A leftover review from a previous cycle, or an
In-Progress ticket in another team, still counts against the limits.

### Selection

When the gate is open, choose from the viewer's assigned issues that are in the
**current cycle** and in the **Todo** state (`TODO_STATE_NAME`, default "Todo").
Selection is scoped to the **watched team** (`LINEAR_TEAM_NAME`, "Engineering"):
in practice that is where all your active-cycle work lives, and — critically —
it means the picked ticket moves into exactly the "In Progress" state the
existing launch trigger already watches, so the launch machinery is unchanged.
(The WIP *counts* above are the only thing that is team-agnostic.)

1. **Drop** any ticket carrying a risk-ish label (`RISK_LABELS`, default
   `migration,infra,security,breaking`) — those are left for a deliberate manual
   start (they are also what `pickup-ticket` would halt on).
2. **Sort** by priority descending, then by the cycle's manual sort order.
   Note Linear's `priority` numbering is inverted (`0`=None, `1`=Urgent … `4`=Low),
   so "highest priority" means `1` first and `0` (None) last; ties break on
   `sortOrder` ascending (lower = higher in the manual list).
3. **Take** the top ticket. If none qualifies, pick nothing this poll.

### Action

The picker issues a single `issueUpdate` GraphQL mutation to move the chosen
ticket **Todo → In Progress**, then logs `[picker] picked ENG-N → In Progress`.

It does **not** launch anything itself. The existing In-Progress trigger detects
the transition on the next poll and runs the current, tested path
(`new-session.sh` → worktree + tmux → autonomous `pickup-ticket`). This keeps a
single source of truth for launching; the only cost is a ≤1-poll (≤3 min) delay
between pick and launch, which is irrelevant here.

Failure handling follows the existing retry semantics: if the move succeeds but
the subsequent launch fails, the ticket is In Progress (count = 1) so the picker
stalls and won't pick more, while the In-Progress trigger retries the launch on
the next poll (it marks an issue seen only after a successful launch).

## Components

- **`src/picker.ts`** — a pure `selectNextTicket(todos, { riskLabels })` that
  filters risk-labeled tickets, sorts (priority desc, then sortOrder asc), and
  returns the top `LinearIssue` or `null`. No I/O; fully unit-testable.
- **`src/linear-api.ts`** additions:
  - `resolveContext` is reused to resolve a **Todo** state context at startup.
  - `fetchCycleTodoIssues(apiKey, ctx)` — the watched team's **active cycle**
    Todo issues assigned to the viewer, selecting
    `id identifier title priority sortOrder` and `labels { nodes { name } }`.
    Scoped by team + assignee + Todo state + `cycle: { isActive: { eq: true } }`.
  - `moveIssueToState(apiKey, issueId, stateId)` — `issueUpdate` mutation.
  - `countAssignedInState(apiKey, viewerId, stateName)` — counts issues matched
    by **assignee + state name only, no team filter**, for the viewer-wide WIP
    limits. Called once for the In-Progress state name and once for the
    In-Review state name. (This is why the counts cannot reuse the team-scoped
    `fetchTriggerIssues`, which filters by a single team's state ID.)
- **`src/watcher.ts`** — a `pickOnce(deps)` orchestration wired into
  `startWatcher`'s poll after the two existing triggers. `deps` exposes
  `autoPick`, `maxReview`, `countInProgress`, `countInReview`,
  `fetchCycleTodos`, `moveToInProgress`, and `log`, so the gate + action are
  testable without network or tmux.
- **`index.ts`** — resolve the Todo context, read the new env vars, and pass a
  picker config into `startWatcher`.

## Configuration (`.env`)

| Var | Default | Meaning |
|-----|---------|---------|
| `AUTO_PICK` | `true` | Autonomous picking on. Set `false` to disable. **On by default in code.** |
| `MAX_REVIEW` | `3` | Max concurrent In-Review tickets before the pipeline stalls. |
| `RISK_LABELS` | `migration,infra,security,breaking` | Comma-separated labels that are never auto-picked. |
| `TODO_STATE_NAME` | `Todo` | The "ready to work" state the picker draws from. |

`AUTO_PICK` defaults on: unset → picking is active. `.env.example` gets these
documented (commented) alongside the existing keys.

## Testing

- `src/picker.test.ts` — `selectNextTicket`: risk-label filtering, priority
  ordering (incl. inverted `None`), sortOrder tie-break, empty → `null`.
- `src/watcher.test.ts` — `pickOnce`: does nothing when `autoPick` is false;
  skips when In Progress > 0; stalls + logs when In Review ≥ cap; picks and calls
  `moveToInProgress` with the selected id when the gate is open; picks nothing
  when no eligible Todo exists.
- `pnpm typecheck` clean.

## Out of scope

- Parallel in-progress work (deliberately capped at 1 for now).
- Tearing down local servers when a review leaves the queue.
- Any change to the launch / `pickup-ticket` / resume paths themselves.
