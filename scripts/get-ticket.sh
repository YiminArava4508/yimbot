#!/bin/bash
# get-ticket.sh - print a Linear ticket as markdown. Runs from anywhere
# (symlinked to ~/get-ticket.sh); resolves back to the yimbot repo so its
# .env supplies LINEAR_API_KEY.
# Usage: get-ticket.sh <ticket>
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <ticket>" >&2
  exit 1
fi

SCRIPT_DIR=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
REPO_DIR=$(dirname "$SCRIPT_DIR")
cd "$REPO_DIR"
exec node --env-file-if-exists=.env --import tsx/esm scripts/get-ticket.ts "$@"
