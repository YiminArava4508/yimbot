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

queue_dir() {
  local d=$HEAVY_STATE_DIR/queue
  mkdir -p "$d" 2>/dev/null
  printf '%s' "$d"
}

lock_path() {
  mkdir -p "$HEAVY_STATE_DIR" 2>/dev/null
  printf '%s' "$HEAVY_STATE_DIR/heavy.lock"
}

heavy_key_for() {
  local branch p n
  branch=$(git -C "$1" branch --show-current 2>/dev/null)
  shopt -s nocasematch
  if [[ $branch =~ ^(eng|sc)-([0-9]+) ]]; then
    p=${BASH_REMATCH[1]}
    n=${BASH_REMATCH[2]}
    shopt -u nocasematch
    printf '%s-%s' "$(printf '%s' "$p" | tr '[:lower:]' '[:upper:]')" "$n"
    return
  fi
  shopt -u nocasematch
  printf '?'
}

ticket_path() {
  printf '%s/%s-%s.json' "$(queue_dir)" "$(date +%s%N)" "$$"
}

json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/ }
  s=${s//$'\t'/ }
  printf '%s' "$s"
}

ticket_write() {
  local path=$1 key=$2 cmd=$3 state=$4
  printf '{"key":"%s","cmd":"%s","state":"%s","since":%s}\n' \
    "$(json_escape "$key")" "$(json_escape "$cmd")" "$state" "$(( $(date +%s%N) / 1000000 ))" \
    > "$path" 2>/dev/null
}

ticket_field() {
  local line
  line=$(cat "$1" 2>/dev/null) || return 1
  [[ $line =~ \"$2\":\"(([^\"\\]|\\.)*)\" ]] && printf '%s' "${BASH_REMATCH[1]}"
}

ticket_stale() {
  local state mtime age limit
  mtime=$(stat -c %Y "$1" 2>/dev/null) || return 0
  state=$(ticket_field "$1" state)
  age=$(( $(date +%s) - mtime ))
  limit=$HEAVY_STALE_WAIT
  [ "$state" = "running" ] && limit=$HEAVY_MAX_JOB
  [ "$age" -gt "$limit" ]
}

ticket_reap() {
  local t
  for t in "$(queue_dir)"/*.json; do
    [ -e "$t" ] || continue
    ticket_stale "$t" && rm -f "$t"
  done
  return 0
}

ticket_head() {
  local t
  for t in $(printf '%s\n' "$(queue_dir)"/*.json 2>/dev/null | sort); do
    [ -e "$t" ] || continue
    printf '%s' "$t"
    return
  done
}

cmd_hold() {
  local cmd=$1
  export YIMBOT_HEAVY_HELD=1
  if ! command -v flock >/dev/null 2>&1; then
    heavy_log "flock missing, running unqueued"
    bash -c "$cmd"
    return $?
  fi
  flock "$(lock_path)" bash -c "$cmd"
}

heavy_log() {
  printf '[%s] heavy-queue: %s\n' "$(date '+%H:%M:%S')" "$*" >> "$HEAVY_STATE_DIR/queue.log" 2>/dev/null || true
}

case "${1:-}" in
  hold) cmd_hold "$2" ;;
esac
