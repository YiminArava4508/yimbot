#!/bin/bash
# flag-archive-check.sh - run checks 2 and 3 of the prod flag-archive policy
# (no code references on gemini main, the rest of the org, or the source folder
# of any build prod runs). Prints JSON; exits non-zero on any failure. Runs from anywhere
# (symlinked to ~/flag-archive-check.sh); resolves back to the yimbot repo so
# its .env applies (FLAG_ARCHIVE_QUIET_HOURS, GEMINI_DIR).
# Usage: flag-archive-check.sh <flag-key> [--gemini-dir <path>]
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <flag-key> [--gemini-dir <path>]" >&2
  exit 2
fi

SCRIPT_DIR=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
REPO_DIR=$(dirname "$SCRIPT_DIR")
cd "$REPO_DIR"
exec node --env-file-if-exists=.env --import tsx/esm scripts/flag-archive-check.ts "$@"
