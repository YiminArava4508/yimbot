#!/bin/bash
# qa-session.sh - tmux + Claude session that writes "how to test" instructions on
# a parent Linear ticket once every child merged and nonprod has the build. No
# worktree and no branch: the session reads the main checkout, drives the user's
# Chrome through the Chrome MCP, and only writes to Linear.
# Usage: qa-session.sh <PARENT> <NONPROD_URL> <CHILDREN_CSV> <PRS_CSV>
#   e.g. qa-session.sh ENG-90 https://np.example "ENG-101,ENG-102" "acme/app#12,#7"
set -uo pipefail

qa_session_name() {
  printf '%s-qa' "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
}

# Pure; unit-tested via sourcing.
qa_seed_prompt() {
  local parent=$1 url=$2 children=$3 prs=$4
  local children_list prs_list
  children_list=$(printf '%s' "$children" | sed 's/,/, /g')
  prs_list=$(printf '%s' "$prs" | sed 's/,/, /g')
  printf 'Run ~/get-ticket.sh %s to read parent Linear issue %s. Its child tickets are: %s. The merged pull requests are: %s. The feature is live on nonprod at %s. Then invoke the qa-instructions skill and follow it exactly.' \
    "$parent" "$parent" "$children_list" "$prs_list" "$url"
}

# Source-guard: tests source this file for the helpers above.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

PARENT=${1:-}
NONPROD_URL=${2:-}
CHILDREN=${3:-}
PRS=${4:-}
[ -n "$PARENT" ] && [ -n "$NONPROD_URL" ] || { echo "Usage: $0 <PARENT> <NONPROD_URL> <CHILDREN_CSV> <PRS_CSV>"; exit 1; }
CODEBASE_PATH=${CODEBASE_PATH:-$HOME/Work/gemini}

ID_UPPER=$(printf '%s' "$PARENT" | tr '[:lower:]' '[:upper:]')
SESSION=$(qa_session_name "$ID_UPPER")
if tmux has-session -t "=$SESSION" 2>/dev/null; then
  echo "Session '$SESSION' already exists, leaving it as is"
  exit 0
fi

# Reuse new-session.sh's claude assembly (models, settings, permission mode).
# shellcheck source=/dev/null
source "$(dirname "$0")/new-session.sh"
declare -F build_claude_cmd >/dev/null ||
  { echo "ERROR: new-session.sh does not define build_claude_cmd"; exit 1; }

[ -f "${SKILLS_DIR:-$HOME/.claude/skills}/qa-instructions/SKILL.md" ] ||
  { echo "ERROR: qa-instructions skill not installed"; exit 1; }

WIN_ID=$(tmux new-session -d -s "$SESSION" -c "$CODEBASE_PATH" -P -F '#{window_id}') ||
  { echo "ERROR: failed to create session '$SESSION'"; exit 1; }
tmux rename-window -t "$WIN_ID" Claude

PROMPT=$(qa_seed_prompt "$ID_UPPER" "$NONPROD_URL" "$CHILDREN" "$PRS")
CMD=$(build_claude_cmd)
tmux send-keys -t "$WIN_ID" "$CMD \"$PROMPT\"" C-m
echo "Created QA session '$SESSION' for $ID_UPPER"
