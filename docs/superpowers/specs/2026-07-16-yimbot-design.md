# yimbot — design

**Date:** 2026-07-16
**Status:** approved

## Purpose

A local daemon at `~/Work/yimbot` that polls Linear and, when an issue
assigned to Yimin in the **Engineering** team moves into the **In Progress**
state, launches a local work session via the existing `~/new-session.sh`
(git worktree + tmux session).

This replaces shortcut-helper's watcher mode for the team's new Linear kanban.
The groomer and planner modes of shortcut-helper are intentionally **not**
ported — this project is watcher-only.

Polling was chosen over Linear webhooks deliberately: no admin dependency, no
public endpoint, no signature verification, and none of the watcher's actions
are latency-sensitive. A 3-minute poll interval is ~20 requests/hour against a
~1,500/hour personal-key rate limit.

## Structure

TypeScript, run directly by Node (same conventions as shortcut-helper:
env-var config, `pnpm start`, Ctrl+C to stop).

```
~/Work/yimbot/
  index.ts          — config from .env, dependency checks, starts watcher,
                      SIGINT/SIGTERM handling
  src/
    linear-api.ts   — minimal GraphQL client: resolve team/state/viewer IDs,
                      query in-progress issues assigned to the user
    watcher.ts      — transition detection + session launching
  .env              — secrets/config (gitignored)
  .env.example      — documented template
  package.json, tsconfig.json, README.md
  docs/superpowers/specs/  — this document
```

## Data flow

Every `POLL_INTERVAL_MINUTES` (default 3):

1. Query `https://api.linear.app/graphql` (header `Authorization: <api key>`)
   for issues filtered by: team = Engineering, assignee = the API key's user
   (resolved via `viewer` at startup), state = In Progress.
2. **First poll baselines**: existing issue IDs are recorded but not acted on,
   so work already in progress does not spawn sessions on daemon startup
   (same semantics as shortcut-helper's watcher).
3. On subsequent polls, any issue ID not in the seen-set triggers
   `bash ~/new-session.sh <name>` (detached, fire-and-forget), then the ID is
   added to the seen-set.

**Session name**: Linear identifier + slugified title, lowercased, sanitized
to `[a-z0-9-]`, max 50 chars — e.g. `eng-42-fix-login-flow`. This matches
`new-session.sh`/`setup-worktree.sh` sanitization so the worktree path under
`~/Work/worktrees/` is consistent.

**Idempotency**: each issue triggers at most once per daemon run. Across
restarts, `new-session.sh` attaches to an existing tmux session instead of
recreating it, so re-triggering after a restart is harmless.

## Configuration (.env)

| Variable | Required | Default |
|---|---|---|
| `LINEAR_API_KEY` | yes | — |
| `LINEAR_TEAM_NAME` | no | `Engineering` |
| `TRIGGER_STATE_NAME` | no | `In Progress` |
| `POLL_INTERVAL_MINUTES` | no | `3` |
| `CODEBASE_PATH` | no | `~/Work/gemini` |

**Codebase sync (added 2026-07-17):** like shortcut-helper, the daemon runs
`git pull --rebase origin main` in `CODEBASE_PATH` at startup and every poll
interval (`src/codebase-sync.ts`, ported verbatim), so new worktree sessions
branch from up-to-date code. Failures (including rebase conflicts) are
logged and never crash the daemon. Startup fails fast if `CODEBASE_PATH` is
missing or not a git repository.

Team name and state name are resolved to IDs once at startup; the viewer
(user) ID is resolved from the API key. Startup fails fast with a clear
message on: missing API key, auth failure, unresolvable team or state name,
missing `~/new-session.sh`, or non-positive poll interval.

## Error handling

- A failed poll (network, rate limit, auth) logs the error and waits for the
  next tick. It never crashes the daemon and never clears the seen-set, so a
  flapping API cannot re-trigger sessions.
- A failed `new-session.sh` spawn logs the issue identifier and does **not**
  mark the issue seen, so it is retried on the next poll.
- Overlapping polls are prevented with a `running` guard (as in
  shortcut-helper).

## Testing

- Transition logic (baseline → detect-new → mark-seen) lives in a pure
  function operating on issue-ID sets, unit-testable without network.
- `pnpm check`: a smoke-test script that runs the real GraphQL query once and
  prints the issues it sees (identifier, title, computed session name) without
  launching anything — used to validate the filter before trusting the daemon.

## Out of scope

- Groomer / planner modes (explicitly dropped).
- Webhooks (the ngrok tunnel + systemd service from earlier setup are unused
  by this project and can be disabled).
- Watching states other than the single trigger state, or issues not assigned
  to the user.
- Running as a systemd service (can be added later; for now `pnpm start` in a
  terminal, matching shortcut-helper usage).
