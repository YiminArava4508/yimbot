# yimbot

Watches a Linear kanban and launches a local work session (git worktree +
tmux, via `~/new-session.sh`) when an issue assigned to you moves into
In Progress.

Watcher-only Linear daemon. Polls the Linear GraphQL
API — no webhooks, no public endpoint. Issues already In Progress when the
daemon starts are baselined and ignored; only transitions that happen while
it runs launch sessions. Each issue launches at most once per run, and a
failed launch is retried on the next poll.

The daemon also keeps the main codebase fresh: every poll interval it runs
`git pull --rebase origin main` in `CODEBASE_PATH` (default
`~/Work/gemini`), so new worktree sessions branch off up-to-date code. Pull
failures are logged and never crash the daemon.

## How it works

First launch onboards you; then the daemon runs one poll loop every
`POLL_INTERVAL_MINUTES`, driving three independent behaviors off your Linear
board plus a codebase sync.

```mermaid
flowchart TD
    A(["pnpm start"]) --> B{".env configured?"}
    B -- no --> W["Onboarding wizard:<br/>authenticate key, pick team and states,<br/>validate codebase, write .env"]
    W --> C["Daemon running"]
    B -- yes --> C

    C --> P{{"Every POLL_INTERVAL_MINUTES (default 3m)"}}

    P --> S["git pull --rebase in CODEBASE_PATH<br/>keep the branch base fresh"]

    P --> T1{"Issue entered<br/>In Progress?"}
    T1 -- yes --> L["new-session.sh:<br/>git worktree + tmux + Claude session<br/>implements the ticket"]

    P --> PK{"AUTO_PICK on,<br/>nothing In Progress,<br/>In Review has room?"}
    PK -- yes --> M["Pick top active-cycle Todo,<br/>move it to In Progress"]
    M -.->|next poll| T1

    P --> T2{"RESUME_ON_REVIEW on and<br/>issue entered In Review?"}
    T2 -- yes --> R["run-local-env.sh:<br/>resume local dev env"]
```

- **Trigger 1 — launch:** an issue assigned to you entering **In Progress**
  creates a worktree + tmux session and kicks off a Claude session to implement it.
- **Picker (`AUTO_PICK`):** when nothing is In Progress and the In-Review queue
  has room (`MAX_REVIEW`), it moves the top-priority active-cycle **Todo** into
  In Progress, which Trigger 1 launches on the next poll.
- **Trigger 2 — resume (`RESUME_ON_REVIEW`, off by default):** an issue entering
  **In Review** resumes that worktree's local dev env.

## Setup

```bash
pnpm install
pnpm start   # first run walks you through onboarding, writes .env, then starts
```

On first launch (no `.env`), `pnpm start` drops into an interactive wizard: it
authenticates your Linear API key, lets you pick your team and workflow states
from the real Linear data, validates the codebase path is a git repo, and
checks the helper scripts exist — then writes `.env` and continues into the
daemon. Re-run it anytime with `pnpm onboard` (backs up the old `.env`). You can
still hand-edit `.env` from `.env.example` if you prefer.

## Usage

```bash
pnpm onboard   # (re)configure via the interactive wizard
pnpm check     # one-shot: print the issues the filter currently matches
pnpm start     # run the daemon (Ctrl+C to stop); onboards first if unconfigured
```

Design doc: `docs/superpowers/specs/2026-07-16-yimbot-design.md`.
