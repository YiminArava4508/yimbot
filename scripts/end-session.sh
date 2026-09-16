#!/bin/bash
# end-session.sh - tear down a git worktree + tmux session created by
# new-session.sh. Generic: no project paths, stacks, or personal data are baked
# in. Configure with the env vars below and an optional teardown hook.
#
# The yimbot cleanup step shells out to ~/end-session.sh <branch> (headless) once
# a PR merges. Install this generic teardown there (or point the daemon at your
# own) with, e.g.:
#     ln -s "$PWD/scripts/end-session.sh" ~/end-session.sh
#
# Usage:
#   end-session.sh              tear down the CURRENT tmux session (interactive)
#   end-session.sh <name>       tear down the named session (headless)
#
# Config (all overridable via the environment):
#   CODEBASE_PATH          base git repo the worktree belongs to     (~/Work/gemini)
#   WORKTREES_DIR          where worktrees live                      (~/Work/worktrees)
#   SESSION_TEARDOWN_HOOK  script run before the worktree is removed,
#                          receiving "<worktree_path> <name>". Put
#                          project-specific teardown (stop containers,
#                          free ports) here.                         (none)

set -uo pipefail

WORKTREES_DIR=${WORKTREES_DIR:-$HOME/Work/worktrees}

log() { echo "[$(date '+%H:%M:%S')] $*"; }
die() {
  log "ERROR: $*"
  exit 1
}

# Sanitize a session name into its worktree dir name - the same rule
# new-session.sh uses, so a session name maps to the dir the launcher created.
# Pure; unit-tested via sourcing.
sanitize_worktree_dir() {
  echo "$1" | sed 's/[^a-zA-Z0-9-]/-/g' | cut -c1-50
}

# The git repo the worktree belongs to. Defaults to ~/Work/gemini (matching the
# daemon's index.ts default) so an interactive teardown works without the env
# var; export CODEBASE_PATH to override. Pure; unit-tested via sourcing.
codebase_path() {
  echo "${CODEBASE_PATH:-$HOME/Work/gemini}"
}

# git branch delete flag. Headless callers (the daemon) have already confirmed
# the PR merged, so force-delete (-D): a squash merge leaves `git branch -d`
# thinking the branch is unmerged. Interactive use keeps the safe -d.
branch_delete_flag() {
  [ "$1" = true ] && echo "-D" || echo "-d"
}

# Teardown steps in execution order. Headless (the daemon) kills the tmux session
# FIRST: it stops the dev server (or any process) writing into the worktree, so
# the subsequent removal doesn't race a live writer regenerating files and wedge
# the whole teardown. Interactive keeps the session LAST - the script runs inside
# that session, so killing it earlier would abort before the worktree is removed.
# Pure; unit-tested via sourcing.
teardown_steps() {
  [ "$1" = true ] && echo "kill_session remove_worktree delete_branch" \
                   || echo "remove_worktree delete_branch kill_session"
}

# Extract the worktree path git has checked branch $2 out into, from `git
# worktree list --porcelain` output ($1). Empty (and returns 1) if no worktree
# holds that branch. Used to recover when a worktree's dir name diverges from
# its branch, so sanitize_worktree_dir cannot find it. Pure; unit-tested via
# sourcing.
worktree_path_for_branch() {
  local porcelain=$1 target="refs/heads/$2" path=""
  while IFS= read -r line; do
    case "$line" in
      "worktree "*) path=${line#worktree } ;;
      "branch $target") echo "$path"; return 0 ;;
    esac
  done <<< "$porcelain"
  return 1
}

# When sourced (e.g. by a test) load the functions above and stop; only run
# teardown when the script is executed directly.
(return 0 2>/dev/null) && return 0

# Session name: the arg if given (headless, e.g. the yimbot daemon), else the
# current tmux session (interactive teardown from inside the session).
HEADLESS=false
if [ -n "${1:-}" ]; then
  NAME=$1
  HEADLESS=true
else
  NAME=$(tmux display-message -p '#S') || die "Could not determine current tmux session"
fi

CODEBASE_PATH=$(codebase_path)

WORKTREE_DIR=$(sanitize_worktree_dir "$NAME")
WORKTREE=$WORKTREES_DIR/$WORKTREE_DIR

if [ ! -d "$WORKTREE" ]; then
  # The conventional dir is absent. A worktree's dir name and its checked-out
  # branch can diverge (e.g. a branch checked out into another session's dir),
  # so ask git which dir actually holds this branch before giving up. Without
  # this, the daemon reconciles by branch but this script only ever looked by
  # sanitized name, so a diverged worktree could never be torn down and the
  # cleanup step looped every heartbeat.
  RESOLVED=$(worktree_path_for_branch "$(git -C "$CODEBASE_PATH" worktree list --porcelain 2>/dev/null)" "$NAME")
  if [ -n "$RESOLVED" ] && [ -d "$RESOLVED" ]; then
    log "Worktree dir diverges from branch; resolved by branch to $RESOLVED"
    WORKTREE=$RESOLVED
  else
    die "'$NAME' has no worktree at $WORKTREE - is this a new-session.sh session?"
  fi
fi

log "Ending session '$NAME'"

# Optional project-specific teardown (stop containers, free ports, etc.),
# receiving "<worktree_path> <name>". Runs while the worktree still exists.
if [ -n "${SESSION_TEARDOWN_HOOK:-}" ]; then
  if [ -f "$SESSION_TEARDOWN_HOOK" ]; then
    log "Running teardown hook: $SESSION_TEARDOWN_HOOK"
    bash "$SESSION_TEARDOWN_HOOK" "$WORKTREE" "$NAME" || log "teardown hook failed - continuing"
  else
    log "WARN: SESSION_TEARDOWN_HOOK set but not found: $SESSION_TEARDOWN_HOOK"
  fi
fi

# Remove the worktree (force: the branch's work has landed), pruning a stale
# registration or a leftover directory git no longer tracks. Returns non-zero on
# a genuine removal failure without aborting: the remaining steps (branch delete)
# must still run, and headless callers surface the failure via the exit code.
remove_worktree() {
  if git -C "$CODEBASE_PATH" worktree remove "$WORKTREE" --force 2>/dev/null; then
    log "Worktree removed"
  elif [ -d "$WORKTREE" ]; then
    log "Not a registered git worktree - removing directory manually"
    if rm -rf "$WORKTREE"; then
      git -C "$CODEBASE_PATH" worktree prune
      log "Worktree directory removed"
    else
      log "ERROR: Failed to remove worktree directory '$WORKTREE'"
      return 1
    fi
  fi
}

delete_branch() {
  if git -C "$CODEBASE_PATH" branch "$(branch_delete_flag "$HEADLESS")" "$NAME" 2>/dev/null; then
    log "Branch '$NAME' deleted"
  elif $HEADLESS; then
    log "Branch '$NAME' not deleted (already gone)"
  else
    log "Branch '$NAME' not deleted (already gone, or unmerged: skipping)"
  fi
}

# Kill the tmux session if it exists. Interactive teardown first moves the
# attached client to another session and opens the chooser (the pane running
# this script is in the session being killed, so this must happen before the
# kill); headless teardown just kills it by name.
kill_session() {
  if tmux has-session -t "=$NAME" 2>/dev/null; then
    if ! $HEADLESS; then
      CLIENT=$(tmux display-message -p '#{client_name}' 2>/dev/null)
      tmux switch-client -n 2>/dev/null || true
      if [ -n "$CLIENT" ]; then
        DEST=$(tmux display-message -t "$CLIENT" -p '#{client_session}' 2>/dev/null)
        [ -n "$DEST" ] && [ "$DEST" != "$NAME" ] && tmux choose-tree -Zs -t "$DEST" 2>/dev/null
      fi
    fi
    log "Killing session '$NAME'"
    tmux kill-session -t "$NAME" 2>/dev/null || true
  else
    log "No tmux session '$NAME' to kill"
  fi
}

rc=0
for step in $(teardown_steps "$HEADLESS"); do
  "$step" || rc=1
done

log "Done"
exit "$rc"
