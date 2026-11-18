#!/bin/bash
# run.sh - launch yimbot and keep it running across self-updates.
#
# yimbot exits 75 after pulling new master code. This relaunches it in the same
# pane. If the new code crashes on boot, it moves back to the previous sha with
# `git reset --keep`, which refuses to touch uncommitted tracked changes and
# never removes untracked files.

set -uo pipefail

CRASH_WINDOW=30
UPDATE_EXIT=75

crashed_on_boot() {
  local code=$1 elapsed=$2
  [ "$code" -ne 0 ] && [ "$code" -ne "$UPDATE_EXIT" ] && [ "$elapsed" -lt "$CRASH_WINDOW" ]
}

can_roll_back() {
  local prev=$1 cur=$2
  [ -n "$prev" ] || return 1
  git merge-base --is-ancestor "$prev" "$cur" 2>/dev/null || return 1
  git merge-base --is-ancestor "$cur" origin/master 2>/dev/null || return 1
  git diff-index --quiet HEAD -- 2>/dev/null
}

roll_back() {
  local prev=$1 cur=$2 lock_changed=0
  git diff --quiet "$prev" "$cur" -- pnpm-lock.yaml || lock_changed=1
  git reset --keep "$prev" || return 1
  if [ "$lock_changed" -eq 1 ]; then
    pnpm install --frozen-lockfile
  fi
}

main() {
  cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." || exit 1
  unset YIMBOT_UPDATED_FROM YIMBOT_ROLLED_BACK YIMBOT_SKIP_SHA

  local prev="" cur start code
  while true; do
    cur=$(git rev-parse HEAD)
    start=$SECONDS
    pnpm start
    code=$?

    if [ "$code" -eq 0 ]; then
      exit 0
    fi

    if [ "$code" -eq "$UPDATE_EXIT" ]; then
      prev=$cur
      export YIMBOT_UPDATED_FROM=$cur
      unset YIMBOT_ROLLED_BACK YIMBOT_SKIP_SHA
      continue
    fi

    if crashed_on_boot "$code" $((SECONDS - start)) && can_roll_back "$prev" "$cur"; then
      echo "${cur:0:7} crashed on boot, rolling back to ${prev:0:7}"
      if roll_back "$prev" "$cur"; then
        export YIMBOT_ROLLED_BACK=$cur YIMBOT_SKIP_SHA=$cur
        unset YIMBOT_UPDATED_FROM
        prev=""
        continue
      fi
    fi

    if crashed_on_boot "$code" $((SECONDS - start)); then
      echo "${cur:0:7} crashed on boot, not rolled back"
    fi
    exit "$code"
  done
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
