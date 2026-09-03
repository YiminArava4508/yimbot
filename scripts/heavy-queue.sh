#!/bin/bash
# heavy-queue.sh - one CPU-heavy job at a time across every Claude session.
#
# Two layers. `flock` is the mutex: the kernel drops it when the holder dies, so
# the slot cannot leak. A ticket directory is the ordering: tickets are advisory,
# so a stale one costs fairness and never mutual exclusion.
#
# Subcommands:
#   pre     PreToolUse hook. Reads the payload on stdin, waits for the slot, and
#           prints an updatedInput decision rewriting the command through `hold`.
#   post    PostToolUse hook. Drops this process group's ticket.
#   hold    Runs a command under the flock. What `pre` rewrites commands to.
#   status  Prints the queue, --json for machines.
#
# Every failure path exits 0 and lets the command run unqueued.

set -uo pipefail

HEAVY_STATE_DIR=${HEAVY_STATE_DIR:-${XDG_RUNTIME_DIR:-/tmp}/yimbot}
HEAVY_CONF=${HEAVY_CONF:-$HOME/.config/yimbot/heavy-jobs.conf}
HEAVY_SELF=$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")

# Defaults matching settings/heavy-jobs.conf, so a missing or partial conf still
# yields a working queue rather than an unset-variable crash in the hot path.
heavy_conf_load() {
  HEAVY_PATTERNS='^(task (generate|gqlgen|build-all|test|test-integration|ci-local)|pnpm (run )?(build|typecheck|test)[a-z:]*|go build|go test)'
  HEAVY_WAIT_TIMEOUT=1200
  HEAVY_MAX_JOB=1800
  HEAVY_STALE_WAIT=5
  [ -f "$HEAVY_CONF" ] && . "$HEAVY_CONF"
  return 0
}

# Sessions run commands as `cd <worktree> && <real command>`. Match against the
# real command, and handle a chain of them.
strip_cd_prefix() {
  local cmd=$1
  while [[ $cmd =~ ^[[:space:]]*cd[[:space:]]+[^\;\&]+\&\&[[:space:]]*(.*)$ ]]; do
    cmd=${BASH_REMATCH[1]}
  done
  printf '%s' "$cmd"
}

is_heavy() {
  local cmd
  [ -n "${YIMBOT_HEAVY_HELD:-}" ] && return 1
  cmd=$(strip_cd_prefix "$1")
  case $cmd in *heavy-queue.sh\ hold*) return 1 ;; esac
  printf '%s' "$cmd" | grep -Eq "$HEAVY_PATTERNS"
}
