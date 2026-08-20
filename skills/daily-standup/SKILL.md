---
name: daily-standup
description: Use when asked for a daily standup, progress check, or async status update on the tickets yimbot is currently working (the yimbot TUI board).
user-invocable: true
---

# Daily standup

Produce a paste-ready async standup message: one line per ticket on the yimbot
board with a progress %, PR state, and what happens next. The board is the set
of active ticket sessions, NOT the assignee's full Linear or Shortcut backlog.
Never report backlog tickets that have no session.

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

3. **Ticket titles.** Event rows carry `label`/`title`, but titles there are
   slugged lowercase and truncated. Fetch the real title from Linear whenever
   the event title looks cut off, using the `LINEAR_API_KEY` in yimbot's
   `.env`. Extract it with
   `grep '^LINEAR_API_KEY=' .env | cut -d= -f2-` (never `source .env`; values
   contain unquoted spaces), then:

   ```bash
   curl -s -H "Authorization: $KEY" -H "Content-Type: application/json" \
     https://api.linear.app/graphql \
     -d '{"query":"{ issue(id: \"ENG-1234\") { identifier title state { name } } }"}'
   ```

## Progress %

| Board status (after the live-PR check) | Reported as | % |
|---|---|---|
| merged (verified `state: MERGED`, not just the event) | merged (mention, then drop next day) | 100 |
| ready to merge / in merge queue | ready to merge | 90 |
| unblocking (merge queue kicked it out) | unblocking merge queue | 85 |
| addressing review / review findings | addressing review | 75 |
| fixing CI / resolving conflict | fixing CI, resolving conflict | 70 |
| draft pr | waiting self review | 60 |
| working, PR open | in progress | 50 |
| working, no PR yet | in progress | 30 |
| needs decision | blocked on decision (say on what) | keep last % |
| dead session (no worktree, no tmux) | stalled, session killed, needs restart | 0 |

A split ticket's % is its furthest-along open child.

## Message shape

```
**Daily standup: yimbot**
- **ENG-1234** <short title> - **NN%** - PR #NNNN <state>, <next step or blocker>
```

Plain hyphens as separators, never em dashes. Sorted by % descending (ties by
higher ticket number first), one line per ticket, each line under ~140
characters. Deliver the message as text to
copy-paste; post it to a channel only when asked and told which channel.
