#!/bin/bash
# split-pr.sh - add a "PR (i/n)" window to the current tmux session for one slice
# of a split ticket, with its own Claude session (so the session-to-PR link is
# 1:1) and a parent-session marker cleanup uses to keep the group together.
# Setup only: the caller has already created the slice branch, pushed it, and
# opened its PR before calling this.
#
# Usage: split-pr.sh <branch> <index> <total> [session]
#   branch   the slice's branch (already pushed to origin)
#   index    this slice's number (1-based)
#   total    total number of slices
#   session  target tmux session (default: the caller's current session)
set -uo pipefail

WORKTREES_DIR=${WORKTREES_DIR:-$HOME/Work/worktrees}

# --- pure helpers (sourceable for tests) ---
pr_window_name() { printf 'PR (%s/%s)' "$1" "$2"; }
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
[ -n "$SESSION" ] || { echo "ERROR: could not resolve a target tmux session"; exit 1; }

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

# Add the detached window and launch Claude in it. Capture the window id so the
# "PR (i/n)" display name (spaces/slashes) never has to be used as a target.
WIN_NAME=$(pr_window_name "$INDEX" "$TOTAL")
WIN_ID=$(tmux new-window -d -t "$SESSION" -n "$WIN_NAME" -c "$WORKTREE" -P -F '#{window_id}') ||
  { echo "ERROR: failed to add window to session '$SESSION'"; exit 1; }
# Link this slice window to its already-open PR with a bare claude (no ticket
# seed): NAME is blanked so launch_claude_in does not inject the pickup-ticket
# prompt. PLAN_MODEL/IMPL_MODEL are still honored by launch_claude_in.
NAME=""
launch_claude_in "$WIN_ID"
echo "Added '$WIN_NAME' to session '$SESSION' for branch '$BRANCH'"
