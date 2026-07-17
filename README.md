# linear-helper

Watches a Linear kanban and launches a local work session (git worktree +
tmux, via `~/new-session.sh`) when an issue assigned to you moves into
In Progress.

Watcher-only port of shortcut-helper for Linear. Polls the Linear GraphQL
API — no webhooks, no public endpoint. Issues already In Progress when the
daemon starts are baselined and ignored; only transitions that happen while
it runs launch sessions. Each issue launches at most once per run, and a
failed launch is retried on the next poll.

The daemon also keeps the main codebase fresh: every poll interval it runs
`git pull --rebase origin main` in `CODEBASE_PATH` (default
`~/Work/gemini`), so new worktree sessions branch off up-to-date code. Pull
failures are logged and never crash the daemon.

## Setup

```bash
pnpm install
cp .env.example .env   # then fill in LINEAR_API_KEY
```

## Usage

```bash
pnpm check   # one-shot: print the issues the filter currently matches
pnpm start   # run the daemon (Ctrl+C to stop)
```

Design doc: `docs/superpowers/specs/2026-07-16-linear-helper-design.md`.
