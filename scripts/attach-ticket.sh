#!/bin/bash
# attach-ticket.sh - upload a file to Linear, print its asset url, delete the
# local file. Runs from anywhere (symlinked to ~/attach-ticket.sh); resolves
# back to the yimbot repo so its .env supplies LINEAR_API_KEY.
# Usage: attach-ticket.sh <file>
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <file>" >&2
  exit 1
fi

SCRIPT_DIR=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
REPO_DIR=$(dirname "$SCRIPT_DIR")
FILE=$(readlink -f "$1")
cd "$REPO_DIR"
exec node --env-file-if-exists=.env --import tsx/esm scripts/attach-ticket.ts "$FILE"
