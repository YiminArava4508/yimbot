#!/bin/bash
# create-subticket.sh - create a Linear sub-issue for one slice of a split
# ticket and zero the parent ticket's estimate (unless --no-zero-parent, which
# leaves the parent's estimate alone). Prints two lines: the new
# subticket identifier, then the slice branch name derived from it.
# Runs from anywhere (symlinked to ~/create-subticket.sh); resolves back to the
# yimbot repo so its .env supplies LINEAR_API_KEY.
#
# Usage: create-subticket.sh <parent-ticket> <title> [points] [--claimable] [--no-zero-parent]
set -euo pipefail

# The flags add no positional args, so the count check still just needs parent + title.
if [ $# -lt 2 ]; then
  echo "Usage: $0 <parent-ticket> <title> [points] [--claimable] [--no-zero-parent]" >&2
  exit 1
fi

SCRIPT_DIR=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
REPO_DIR=$(dirname "$SCRIPT_DIR")
cd "$REPO_DIR"
exec node --env-file-if-exists=.env --import tsx/esm scripts/subticket.ts "$@"
