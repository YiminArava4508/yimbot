#!/bin/bash
# refine-session.sh - tmux + Claude session that refines one Linear ticket:
# estimate it in place, or decompose it into pointed subtickets wired with
# blocks relations. No worktree and no branch: the session reads the main
# checkout and only writes to Linear.
# Usage: refine-session.sh <ticket-identifier>   (e.g. ENG-123)
set -uo pipefail

TICKET=${1:-}
[ -n "$TICKET" ] || { echo "Usage: $0 <ticket-identifier>"; exit 1; }
: "${CODEBASE_PATH:?set CODEBASE_PATH to the git repo the session reads}"

SESSION="refine-$(printf '%s' "$TICKET" | tr '[:upper:]' '[:lower:]')"
if tmux has-session -t "=$SESSION" 2>/dev/null; then
  echo "Session '$SESSION' already exists, leaving it as is"
  exit 0
fi

# Reuse new-session.sh's claude assembly (models, settings, permission mode).
# shellcheck source=/dev/null
source "$(dirname "$0")/new-session.sh"

WIN_ID=$(tmux new-session -d -s "$SESSION" -c "$CODEBASE_PATH" -P -F '#{window_id}') ||
  { echo "ERROR: failed to create session '$SESSION'"; exit 1; }
tmux rename-window -t "$WIN_ID" Claude

ID_UPPER=$(printf '%s' "$TICKET" | tr '[:lower:]' '[:upper:]')
PROMPT="Fetch Linear issue $ID_UPPER via the Linear MCP (mcp__linear-server__get_issue) and read its description and comments. Then invoke the refine-ticket skill and follow it exactly."
CMD=$(build_claude_cmd)
tmux send-keys -t "$WIN_ID" "$CMD \"$PROMPT\"" C-m
echo "Created refine session '$SESSION' for $ID_UPPER"
