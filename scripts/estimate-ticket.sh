#!/bin/bash
# estimate-ticket.sh - set a Linear ticket's estimate. Runs from anywhere
# (symlinked to ~/estimate-ticket.sh); resolves back to the yimbot repo so its
# .env supplies LINEAR_API_KEY.
# Usage: estimate-ticket.sh <ticket> <points>
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "Usage: $0 <ticket> <points>" >&2
  exit 1
fi

SCRIPT_DIR=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
REPO_DIR=$(dirname "$SCRIPT_DIR")
cd "$REPO_DIR"
exec node --env-file-if-exists=.env --import tsx/esm scripts/estimate-ticket.ts "$@"
