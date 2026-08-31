---
name: daily-standup
description: Use when asked for a daily standup, progress check, or async status update on the tickets yimbot is currently working (the yimbot TUI board).
user-invocable: true
---

# Daily standup

Produce a paste-ready async standup message for a product audience: short,
grouped by workstream, in plain language. The board is the set of active
ticket sessions, NOT the assignee's full Linear or Shortcut backlog. Never
report backlog tickets that have no session.

Report only tickets that are both **in progress** (Linear state type `started`,
e.g. In Progress / In Review) and **in the current Linear cycle**. Drop rows
whose ticket is Done, Todo/unstarted, or in a past or future cycle, even if the
board still lists them; drop silently, the message stays clean.

## Gather board state

1. **Reduce the board from the event log.** The TUI derives its rows from
   `events.jsonl` in the yimbot repo root: latest status event per ticket key,
   dropping tickets whose latest event is terminal (`merged`, `refined`):

   ```bash
   jq -s '[.[] | select(.kind | IN("task_started","review_started","ci_fix_started",
     "conflict_fix_started","blocked_fix_started","ready_to_merge","draft_pr",
     "ready_regressed","merged","refined","needs_decision","review_findings"))]
     | group_by(.key) | map(last)
     | map(select(.kind | IN("merged","refined") | not))' events.jsonl
   ```

2. **Cross-check live PR state; the live PR wins.** Events go stale, so when
   the event and the PR disagree, report the row matching the live PR (e.g. a
   `ci_fix_started` event whose PR now shows green CI and `CHANGES_REQUESTED`
   is "addressing review"). Each ticket has one or more worktrees under
   `~/Work/worktrees/` whose name starts with the lowercased ticket key. From
   inside each worktree:

   ```bash
   gh pr view "$(git branch --show-current)" \
     --json number,state,isDraft,reviewDecision,statusCheckRollup
   ```

   Only FAILURE conclusions count against "CI green"; SKIPPED, NEUTRAL, and
   CANCELLED shadow checks are non-blocking.

   Extra worktrees with the same ticket prefix are split PRs: name each child
   PR with its own state on the ticket's single line, including already-merged
   children while the ticket is still on the board. A matching worktree with
   no PR is the not-yet-pushed branch: report it as "in progress, no PR". Only
   omit it when its branch has no commits beyond what the split children
   already merged or opened; when unsure, report it.

   Never call a PR "merged" or "landed" from events alone. A `merged` event
   can point at a PR that was closed unmerged (e.g. superseded by a split
   sibling). Before reporting any PR as merged, verify with:

   ```bash
   gh pr view <number> --json state,mergedAt
   ```

   Only `state: MERGED` counts as landed. `CLOSED` with a null `mergedAt` is
   abandoned or superseded: say "PR #NNNN closed (superseded by #MMMM)" if a
   sibling landed the work, otherwise report the ticket as not done.

   A board ticket with **no matching worktree and no tmux session**
   (`tmux ls` has no session whose name starts with the lowercased ticket
   key) is a dead session: the event log went stale without a terminal
   event. Report it as "stalled, session killed, needs restart", not as in
   progress.

3. **Ticket titles, state, and cycle.** Event rows carry `label`/`title`, but
   titles there are slugged lowercase and truncated. Fetch every board ticket
   from Linear (real title, state type, cycle) using the `LINEAR_API_KEY` in
   yimbot's `.env`. Extract it with
   `grep '^LINEAR_API_KEY=' .env | cut -d= -f2-` (never `source .env`; values
   contain unquoted spaces), then:

   ```bash
   curl -s -H "Authorization: $KEY" -H "Content-Type: application/json" \
     https://api.linear.app/graphql \
     -d '{"query":"{ issue(id: \"ENG-1234\") { identifier title state { name type } cycle { number startsAt endsAt } } }"}'
   ```

   The current cycle is the one whose `startsAt`/`endsAt` bracket today. Keep
   the ticket only when `state.type == "started"` AND its cycle is current.

## Status wording

Translate engineering state into product language; the technical detail above
is input, not output. Never mention PR numbers, draft status, CI, worktrees,
branches, or merge queues in the message.

| Board status (after the live-PR check) | Say |
|---|---|
| merged (verified `state: MERGED`) | shipped |
| ready to merge / in merge queue | landing today |
| addressing review / review findings | in review, addressing feedback |
| fixing CI / resolving conflict / blocked_fix | in final review, fixing test failures |
| draft pr | in final review |
| working (PR open or not) | in progress |
| needs decision | blocked: <the decision needed, in plain terms> |
| dead session | paused, needs a restart on my side |

## Message shape

```
**Standup - <Mon DD>**

**<Workstream>** - <on track | at risk | blocked>
- <outcome in plain language>, <status>.
- Next up: <what starts next>.
```

Group tickets into 2-4 workstreams by feature or initiative (sibling tickets
from one epic or split are one workstream); infer groupings from ticket titles
and Linear projects. Lead each bullet with the user-facing outcome, not the
implementation. One bullet may cover several tickets. Keep the whole message
under ~10 lines; no ticket keys unless asked. Plain hyphens, never em dashes.
Flag risks and blockers on the workstream line, never buried. Deliver as text
to copy-paste; post to a channel only when asked and told which channel.
