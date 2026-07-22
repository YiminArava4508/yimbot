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

The first time you run it, yimbot asks a few setup questions. After that it
quietly checks your Linear board every few minutes — its **heartbeat** — and can
do three things (plus keep your code up to date):

```mermaid
flowchart TD
    A(["Start yimbot"]) --> B{"Is it set up yet?"}
    B -- no --> W["First-time setup:<br/>answer a few questions,<br/>your answers are saved"]
    W --> C["yimbot is running,<br/>watching your Linear board"]
    B -- yes --> C

    C --> P{{"Heartbeat: every few<br/>minutes, check the board"}}

    P --> S["Keep the code<br/>up to date"]

    P --> G1["Start new work"]
    G1 --> T1{"Did you move a card<br/>to 'In Progress'?"}
    T1 -- yes --> L["Open a fresh workspace and<br/>let Claude start building it"]

    P --> G2["Grab the next task"]
    G2 --> PK{"Free to take on more?<br/>nothing in progress,<br/>review not backed up"}
    PK -- yes --> M["Take the top to-do<br/>and start it"]
    M -.->|next check| T1

    P --> G3["Reopen for a look"]
    G3 --> T2{"Did a card move to<br/>'In Review'? (if turned on)"}
    T2 -- yes --> R["Bring its app back up<br/>so you can review it"]

    classDef launch fill:#c6f6d5,stroke:#2f855a,color:#1a202c;
    classDef pick fill:#bee3f8,stroke:#2b6cb0,color:#1a202c;
    classDef resume fill:#feebc8,stroke:#c05621,color:#1a202c;
    classDef sync fill:#e2e8f0,stroke:#718096,color:#1a202c;
    class G1,T1,L launch;
    class G2,PK,M pick;
    class G3,T2,R resume;
    class S sync;
    linkStyle 5 stroke:#718096,stroke-width:2px;
    linkStyle 6,7,8 stroke:#2f855a,stroke-width:2px;
    linkStyle 9,10,11,12 stroke:#2b6cb0,stroke-width:2px;
    linkStyle 13,14,15 stroke:#c05621,stroke-width:2px;
```

- **Start new work (green):** when you move a card to **In Progress**, yimbot
  opens a fresh, isolated copy of the code and has Claude start building it.
- **Grab the next task (blue):** when nothing is being worked on and the review
  pile isn't too deep, it pulls your top to-do into progress so the launch step
  picks it up next time. *(optional; setting: `AUTO_PICK`)*
- **Reopen for a look (amber):** when a card moves to **In Review**, it brings
  that card's app back up so you can try it. *(off by default; setting:
  `RESUME_ON_REVIEW`)*

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

## Session launcher

When an issue enters the launch state, the daemon shells out to
`~/new-session.sh <name>`. A generic, self-contained launcher ships in this repo
at [`scripts/new-session.sh`](scripts/new-session.sh): it creates (or reuses) a
git worktree off `CODEBASE_PATH`, opens a tmux session with a Claude window, and
seeds ticket sessions (`eng-…` / `sc-…`) to hand off to the `pickup-ticket`
skill. Install it where the daemon expects it:

```bash
ln -s "$PWD/scripts/new-session.sh" ~/new-session.sh
```

Nothing project-specific is baked in. Point it at your repo and, if you need
per-worktree setup (ports, env files, dependency installs) or a dev-env command,
wire the optional hooks:

```bash
export CODEBASE_PATH=~/Work/your-repo
export SESSION_EDIT_DIRS="frontend backend"      # optional editor windows
export SESSION_SETUP_HOOK=~/my-worktree-setup.sh # optional; called <worktree> <name>
export SESSION_LOCAL_ENV_CMD="docker compose up" # optional; staged in shell history
export PLAN_MODEL=opus                            # optional; model the session plans on
export IMPL_MODEL=sonnet                          # optional; model for implementation subagents
```

The daemon passes `PLAN_MODEL` / `IMPL_MODEL` through from its `.env` (set them in
`pnpm onboard`): the ticket session plans on `PLAN_MODEL`, and the pickup-ticket
skill runs its implementation subagents on `IMPL_MODEL` — so planning and
implementation can use different models.
