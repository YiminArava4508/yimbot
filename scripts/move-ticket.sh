#!/bin/bash
# move-ticket.sh - move a Linear ticket to a workflow state by name. Runs from anywhere
# (symlinked to ~/move-ticket.sh); resolves back to the yimbot repo so its
# .env supplies LINEAR_API_KEY.
# Usage: move-ticket.sh <ticket> "<state name>"
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "Usage: $0 <ticket> '<state name>'" >&2
  exit 1
fi

SCRIPT_DIR=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
REPO_DIR=$(dirname "$SCRIPT_DIR")
cd "$REPO_DIR"
exec node --env-file-if-exists=.env --import tsx/esm scripts/move-ticket.ts "$@"
