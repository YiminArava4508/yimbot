#!/bin/bash
# new-session.sh — create (or reuse) a git worktree + tmux session for a branch,
# then open a Claude window in it. Generic: no project paths, stacks, or personal
# data are baked in. Configure with the env vars below and optional hooks.
#
# The yimbot daemon shells out to ~/new-session.sh when an issue enters the
# launch state. Install this generic launcher there (or point the daemon at your
# own) with, e.g.:
#     ln -s "$PWD/scripts/new-session.sh" ~/new-session.sh
#
# Config (all overridable via the environment):
#   CODEBASE_PATH          base git repo to branch from             (required)
#   WORKTREES_DIR          where worktrees are created              (~/Work/worktrees)
#   EDITOR                 editor for the optional edit windows     ($EDITOR, else vi)
#   SESSION_EDIT_DIRS      space-separated subdirs to open, each in
#                          its own editor window, e.g. "frontend backend"  (none)
#   SESSION_SETUP_HOOK     script run once after the worktree is
#                          created; receives "<worktree_path> <name>".
#                          Put project-specific port/env/dep setup here.  (none)
#   SESSION_LOCAL_ENV_CMD  command staged into the shell window's
#                          history (Up then Enter runs it) to start
#                          the local dev env on demand              (none)

set -uo pipefail

WORKTREES_DIR=${WORKTREES_DIR:-$HOME/Work/worktrees}
EDITOR=${EDITOR:-vi}

log() { echo "[$(date '+%H:%M:%S')] $*"; }
die() {
  log "ERROR: $*"
  exit 1
}

# Build the Claude seed prompt for a session name. Echoes a fetch-then-handoff
# prompt for recognized ticket sessions (sc-<id>-… / eng-<id>-…), or nothing for
# any other name. Kept as a pure function so it can be unit-tested via sourcing.
seed_prompt_for() {
  local name=$1
  if [[ "$name" =~ ^sc-([0-9]+)- ]]; then
    printf 'Fetch Shortcut story %s via the Shortcut MCP (mcp__shortcut__stories-get-by-id) and read its description, acceptance criteria, and comments. Then invoke the pickup-ticket skill and follow it exactly.' "${BASH_REMATCH[1]}"
  elif [[ "$name" =~ ^eng-([0-9]+)- ]]; then
    printf 'Fetch Linear issue ENG-%s via the Linear MCP (mcp__linear-server__get_issue) and read its description and comments. Then invoke the pickup-ticket skill and follow it exactly.' "${BASH_REMATCH[1]}"
  fi
}

# When sourced (e.g. by a test) load the functions above and stop; only run
# session setup when the script is executed directly.
(return 0 2>/dev/null) && return 0

NAME=${1:-}
[ -n "$NAME" ] || {
  echo "Usage: $0 <name>"
  exit 1
}

: "${CODEBASE_PATH:?set CODEBASE_PATH to the git repo to branch from}"
git -C "$CODEBASE_PATH" rev-parse --git-dir >/dev/null 2>&1 ||
  die "CODEBASE_PATH is not a git repo: $CODEBASE_PATH"

# Sanitize the name into a worktree dir (same rule the daemon's slug uses).
WORKTREE_DIR=$(echo "$NAME" | sed 's/[^a-zA-Z0-9-]/-/g' | cut -c1-50)
WORKTREE=$WORKTREES_DIR/$WORKTREE_DIR

# --- Create or reuse the worktree ---
# Reuse if fully set up; prune a stale git registration whose dir is gone; remove
# a leftover dir that git doesn't know about; then add the worktree, checking out
# an existing branch (local or origin) or creating a new one.
create_worktree() {
  local registered=false
  if git -C "$CODEBASE_PATH" worktree list --porcelain | grep -qF "worktree $WORKTREE"; then
    registered=true
  fi
  if $registered && [ -d "$WORKTREE" ]; then
    log "Worktree already exists at $WORKTREE"
    return 0
  fi
  if $registered && [ ! -d "$WORKTREE" ]; then
    log "Pruning stale worktree registration (directory missing)"
    git -C "$CODEBASE_PATH" worktree prune
  elif [ -d "$WORKTREE" ]; then
    log "Removing stale directory $WORKTREE (not a registered worktree)"
    rm -rf "$WORKTREE"
  fi
  mkdir -p "$WORKTREES_DIR"
  if git -C "$CODEBASE_PATH" show-ref --verify --quiet "refs/heads/$NAME" ||
    git -C "$CODEBASE_PATH" show-ref --verify --quiet "refs/remotes/origin/$NAME"; then
    log "Checking out existing branch '$NAME'"
    git -C "$CODEBASE_PATH" worktree add "$WORKTREE" "$NAME" || die "git worktree add failed"
  else
    log "Creating new branch '$NAME'"
    git -C "$CODEBASE_PATH" worktree add "$WORKTREE" -b "$NAME" || die "git worktree add failed"
  fi
}
create_worktree

# --- Optional project-specific setup (ports, env files, dependency installs) ---
if [ -n "${SESSION_SETUP_HOOK:-}" ]; then
  if [ -f "$SESSION_SETUP_HOOK" ]; then
    log "Running setup hook: $SESSION_SETUP_HOOK"
    bash "$SESSION_SETUP_HOOK" "$WORKTREE" "$NAME" || die "setup hook failed"
  else
    log "WARN: SESSION_SETUP_HOOK set but not found: $SESSION_SETUP_HOOK"
  fi
fi

# --- Tmux session ---
if tmux has-session -t "$NAME" 2>/dev/null; then
  log "Session '$NAME' already exists, switching to it..."
  if [ -n "${TMUX:-}" ]; then
    tmux switch-client -t "$NAME" || die "Failed to switch to session '$NAME'"
  elif [ -t 0 ]; then
    tmux attach -t "$NAME" || die "Failed to attach to session '$NAME'"
  else
    log "No TTY; session '$NAME' already running, leaving detached"
  fi
  exit 0
fi

# Capture the first window id so the script is independent of base-index.
FIRST_INFO=$(tmux new-session -d -s "$NAME" -c "$WORKTREE" -P -F '#{window_id} #{pane_id}') ||
  die "Failed to create tmux session '$NAME'"
read -r FIRST_WINDOW _FIRST_PANE <<<"$FIRST_INFO"
log "Tmux session created"

# Window 0: a shell in the worktree. If a local-env command is configured, stage
# it in shell history (Up + Enter) rather than auto-starting it (memory cost).
if [ -n "${SESSION_LOCAL_ENV_CMD:-}" ]; then
  tmux send-keys -t "$NAME" "echo 'Local dev not started. Press Up then Enter to run: $SESSION_LOCAL_ENV_CMD'" C-m
  tmux send-keys -t "$NAME" "history -s '$SESSION_LOCAL_ENV_CMD'" C-m
fi

# Optional editor windows, one per configured subdir.
for dir in ${SESSION_EDIT_DIRS:-}; do
  tmux new-window -t "$NAME" -n "$dir" -c "$WORKTREE/$dir"
  tmux send-keys -t "$NAME:$dir" "$EDITOR" C-m
done

# Claude window. Ticket sessions (sc-<id>-… / eng-<id>-…) are seeded to fetch the
# ticket and hand off to the pickup-ticket skill; any other name gets a bare claude.
tmux new-window -t "$NAME" -n Claude -c "$WORKTREE"
CLAUDE_PROMPT=$(seed_prompt_for "$NAME")
if [ -n "$CLAUDE_PROMPT" ]; then
  tmux send-keys -t "$NAME:Claude" "claude \"$CLAUDE_PROMPT\"" C-m
else
  tmux send-keys -t "$NAME:Claude" "claude" C-m
fi

log "All windows set up. Switching to session '$NAME'"
tmux select-window -t "$FIRST_WINDOW"

# Switch if already in tmux, attach on a terminal; when launched headless (e.g. by
# the yimbot daemon) leave the session detached and exit 0.
if [ -n "${TMUX:-}" ]; then
  tmux switch-client -t "$NAME" || die "Failed to switch to session '$NAME'"
elif [ -t 0 ]; then
  tmux attach -t "$NAME" || die "Failed to attach to session '$NAME'"
else
  log "No TTY; session '$NAME' left detached"
fi
