#!/bin/bash
# needs-decision.sh - raise "needs decision" on the board for this worktree's
# ticket, with a reason, so the row stops showing as "working" while a human
# decides. Run it from the session's worktree (symlinked to ~/needs-decision.sh).
# Usage: needs-decision.sh "<reason>"
set -u

if [ $# -lt 1 ] || [ -z "$1" ]; then
  echo "Usage: $0 \"<reason>\"" >&2
  exit 1
fi

# shellcheck disable=SC1091
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/new-session.sh"
emit_hook_event needs_decision "$1"
emit_hook_event flagged decision
