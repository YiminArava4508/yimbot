#!/bin/bash
# split-pr.sh - create a full worktree + tmux session for one slice of a split
# ticket, with its own Claude session (so the session-to-PR link is 1:1) and a
# parent-session marker cleanup uses to keep the group together. The slice
# session is named after the slice branch, exactly like a new-session.sh ticket
# session, so it shows on the board on its own and end-session.sh can tear it
# down by branch name.
# Setup only: the caller has already created the slice branch, pushed it, and
# opened its PR before calling this.
#
# Usage: split-pr.sh <branch> <index> <total> [session]
#   branch   the slice's branch (already pushed to origin)
#   index    this slice's number (1-based)
#   total    total number of slices
#   session  parent tmux session the slice belongs to
#            (default: the caller's current session)
set -uo pipefail

WORKTREES_DIR=${WORKTREES_DIR:-$HOME/Work/worktrees}

# --- pure helpers (sourceable for tests) ---
resolve_target_session() {
  if [ -n "${1:-}" ]; then printf '%s' "$1"; else tmux display-message -p '#S'; fi
}
parent_marker_path() { printf '%s/.yimbot-parent-session' "$1"; }

# When sourced (e.g. by a test) load the helpers above and stop.
(return 0 2>/dev/null) && return 0

# --- main ---
BRANCH=${1:-}
INDEX=${2:-}
TOTAL=${3:-}
SESSION_ARG=${4:-}
if [ -z "$BRANCH" ] || [ -z "$INDEX" ] || [ -z "$TOTAL" ]; then
  echo "Usage: $0 <branch> <index> <total> [session]"
  exit 1
fi

: "${CODEBASE_PATH:?set CODEBASE_PATH to the git repo to branch from}"

SESSION=$(resolve_target_session "$SESSION_ARG")
[ -n "$SESSION" ] || { echo "ERROR: could not resolve a parent tmux session"; exit 1; }

# Reuse new-session.sh's worktree + Claude helpers. NAME differs from BRANCH so
# create_worktree fetches the (already-pushed) origin branch and tracks it.
# shellcheck source=/dev/null
source "$(dirname "$0")/new-session.sh"
NAME=$SESSION
WORKTREE_DIR=$(echo "$BRANCH" | sed 's/[^a-zA-Z0-9-]/-/g' | cut -c1-50)
WORKTREE=$WORKTREES_DIR/$WORKTREE_DIR
create_worktree

# Optional project-specific setup (ports/env), same hook new-session.sh runs.
if [ -n "${SESSION_SETUP_HOOK:-}" ] && [ -f "${SESSION_SETUP_HOOK}" ]; then
  bash "$SESSION_SETUP_HOOK" "$WORKTREE" "$NAME" || echo "WARN: setup hook failed for $WORKTREE"
fi

# Back-pointer so the cleanup step groups this slice under its parent session.
printf '%s\n' "$SESSION" > "$(parent_marker_path "$WORKTREE")"

# Flag the ticket's integration worktree as a split parent (idempotent) so the
# cleanup step spares it for the whole split. A backstop: the split flow also
# writes this before closing the ticket PR, which covers the pre-first-slice race.
INTEGRATION_WT="$WORKTREES_DIR/$(echo "$SESSION" | sed 's/[^a-zA-Z0-9-]/-/g' | cut -c1-50)"
[ -d "$INTEGRATION_WT" ] && : > "$INTEGRATION_WT/.yimbot-split-parent"

# Create the slice's own detached session, named by branch so teardown(branch)
# kills it, and launch Claude in it. If the session already exists (a re-run of
# the split flow) leave it alone rather than stacking a second Claude window.
if tmux has-session -t "=$BRANCH" 2>/dev/null; then
  echo "Session '$BRANCH' already exists for slice $INDEX/$TOTAL, leaving it as is"
  exit 0
fi
WIN_ID=$(tmux new-session -d -s "$BRANCH" -c "$WORKTREE" -P -F '#{window_id}') ||
  { echo "ERROR: failed to create session '$BRANCH'"; exit 1; }
tmux rename-window -t "$WIN_ID" Claude
# Link this slice session to its already-open PR with a bare claude (no ticket
# seed): NAME is blanked so launch_claude_in does not inject the pickup-ticket
# prompt. PLAN_MODEL/IMPL_MODEL are still honored by launch_claude_in.
NAME=""
launch_claude_in "$WIN_ID"
echo "Created session '$BRANCH' (slice $INDEX/$TOTAL of '$SESSION')"
