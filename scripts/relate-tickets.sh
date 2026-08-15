#!/bin/bash
# relate-tickets.sh - record "<blocker> blocks <blocked>" in Linear. Runs from
# anywhere (symlinked to ~/relate-tickets.sh); resolves back to the yimbot repo
# so its .env supplies LINEAR_API_KEY.
# Usage: relate-tickets.sh <blocker-ticket> <blocked-ticket>
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "Usage: $0 <blocker-ticket> <blocked-ticket>" >&2
  exit 1
fi

SCRIPT_DIR=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
REPO_DIR=$(dirname "$SCRIPT_DIR")
cd "$REPO_DIR"
exec node --env-file-if-exists=.env --import tsx/esm scripts/relate-tickets.ts "$@"
