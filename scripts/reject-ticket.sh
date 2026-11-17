#!/bin/bash
# reject-ticket.sh - reject a ticket whose planned size is far above its estimate. Runs from anywhere
# (symlinked to ~/reject-ticket.sh); resolves back to the yimbot repo so its
# .env supplies LINEAR_API_KEY.
# Usage: reject-ticket.sh <ticket> <planned-points> <reason | ->
set -euo pipefail

if [ $# -ne 3 ]; then
  echo "Usage: $0 <ticket> <planned-points> <reason | ->" >&2
  exit 1
fi

SCRIPT_DIR=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
REPO_DIR=$(dirname "$SCRIPT_DIR")
cd "$REPO_DIR"
exec node --env-file-if-exists=.env --import tsx/esm scripts/reject-ticket.ts "$@"
