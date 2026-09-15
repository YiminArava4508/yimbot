#!/bin/bash
# comment-ticket.sh - post a comment on a Linear ticket ("-" reads the body from stdin). Runs from anywhere
# (symlinked to ~/comment-ticket.sh); resolves back to the yimbot repo so its
# .env supplies LINEAR_API_KEY.
# Usage: comment-ticket.sh [--upsert <marker>] <ticket> <body | ->
set -euo pipefail

if [ $# -ne 2 ] && [ $# -ne 4 ]; then
  echo "Usage: $0 [--upsert <marker>] <ticket> <body | ->" >&2
  exit 1
fi

SCRIPT_DIR=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
REPO_DIR=$(dirname "$SCRIPT_DIR")
cd "$REPO_DIR"
exec node --env-file-if-exists=.env --import tsx/esm scripts/comment-ticket.ts "$@"
