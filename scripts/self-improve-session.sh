#!/bin/bash
# self-improve-session.sh - tmux + Claude session that runs one self-improvement
# job on the yimbot repo itself, in its own worktree off origin/master. The
# session opens a draft PR (or nothing) and exits; the daemon tears it down.
# Usage: self-improve-session.sh <job-id> <branch>
#   e.g. self-improve-session.sh dead-code-scan chore/self-improve-dead-code-scan-2026-11-24
set -uo pipefail

self_improve_session_name() {
  printf 'self-improve-%s' "$1"
}

self_improve_branch() {
  printf 'chore/self-improve-%s-%s' "$1" "$2"
}

# Both values end up inside a double-quoted tmux send-keys line and a git ref,
# so only plain characters are allowed.
self_improve_args_safe() {
  local job=$1 branch=$2
  [[ "$job" =~ ^[a-z0-9-]+$ ]] || return 1
  [[ "$branch" =~ ^chore/self-improve-[a-zA-Z0-9._/-]+$ ]] || return 1
  return 0
}

# The pane runs a shell; ending it with `exit` after claude makes the tmux
# session end when claude does, so the daemon sees a finished run.
self_improve_launch_line() {
  printf '%s "%s"; exit' "$1" "$2"
}

# Pure; unit-tested via sourcing.
self_improve_seed_prompt() {
  local job=$1 skill=$2
  printf 'Invoke the %s skill now. It follows the self-improve-contract skill: do exactly that job, verify, open a draft PR only if something changed, then exit claude. Job id: %s.' \
    "$skill" "$job"
}

# Source-guard: tests source this file for the helpers above.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

JOB=${1:-}
BRANCH=${2:-}
[ -n "$JOB" ] && [ -n "$BRANCH" ] || { echo "Usage: $0 <job-id> <branch>"; exit 1; }
self_improve_args_safe "$JOB" "$BRANCH" ||
  { echo "ERROR: bad job id or branch (job: [a-z0-9-], branch: chore/self-improve-...)" >&2; exit 1; }

REPO=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
SESSION=$(self_improve_session_name "$JOB")
if tmux has-session -t "=$SESSION" 2>/dev/null; then
  echo "Session '$SESSION' already exists, leaving it as is"
  exit 0
fi

# shellcheck source=/dev/null
source "$(dirname "$0")/new-session.sh"
declare -F build_claude_cmd >/dev/null ||
  { echo "ERROR: new-session.sh does not define build_claude_cmd"; exit 1; }

SKILLS=${SKILLS_DIR:-$HOME/.claude/skills}
for skill in "$JOB" self-improve-contract; do
  [ -f "$SKILLS/$skill/SKILL.md" ] || { echo "ERROR: $skill skill not installed"; exit 1; }
done

WT_ROOT=${SELF_IMPROVE_WORKTREE_ROOT:-$HOME/Work/worktrees}
WORKTREE="$WT_ROOT/$SESSION"
[ ! -e "$WORKTREE" ] || { echo "ERROR: $WORKTREE already exists"; exit 1; }
mkdir -p "$WT_ROOT"
git -C "$REPO" fetch -q origin master ||
  { echo "ERROR: git fetch origin master failed"; exit 1; }
git -C "$REPO" worktree add -q -b "$BRANCH" "$WORKTREE" origin/master ||
  { echo "ERROR: failed to create worktree for $BRANCH"; exit 1; }

WIN_ID=$(tmux new-session -d -s "$SESSION" -c "$WORKTREE" -P -F '#{window_id}') || {
  git -C "$REPO" worktree remove --force "$WORKTREE"
  git -C "$REPO" branch -D "$BRANCH" >/dev/null 2>&1
  echo "ERROR: failed to create session '$SESSION'"
  exit 1
}
tmux rename-window -t "$WIN_ID" Claude

PROMPT=$(self_improve_seed_prompt "$JOB" "$JOB")
CMD=$(build_claude_cmd)
tmux send-keys -t "$WIN_ID" "$(self_improve_launch_line "$CMD" "$PROMPT")" C-m
echo "Created self-improve session '$SESSION' on $BRANCH"
