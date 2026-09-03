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

# jq rather than a bash regex: the command field is JSON-escaped and can carry
# quotes and newlines, and getting that wrong means matching the wrong string.
payload_field() {
  printf '%s' "$1" | jq -er "$2" 2>/dev/null
}

# Single-quote a string for safe reinjection into a shell command line.
shell_quote() {
  printf "'%s'" "${1//\'/\'\\\'\'}"
}

session_ticket_file() {
  local d=$HEAVY_STATE_DIR/current
  mkdir -p "$d" 2>/dev/null
  printf '%s/%s' "$d" "${1//[^A-Za-z0-9_-]/_}"
}

# Poll until this ticket reaches the head. Touch it every pass: that heartbeat
# is what lets other waiters reap this ticket promptly if the session dies.
wait_for_head() {
  local mine=$1 deadline=$(( $(date +%s) + HEAVY_WAIT_TIMEOUT ))
  while true; do
    ticket_reap
    [ -e "$mine" ] || return 1
    [ "$(ticket_head)" = "$mine" ] && return 0
    [ "$(date +%s)" -ge "$deadline" ] && return 1
    touch "$mine" 2>/dev/null
    sleep 0.5
  done
}

cmd_pre() {
  local payload cmd cwd session mine
  payload=$(cat)
  cmd=$(payload_field "$payload" '.tool_input.command') || return 0
  [ -n "$cmd" ] || return 0
  is_heavy "$cmd" || return 0

  cwd=$(payload_field "$payload" '.cwd') || cwd=$PWD
  session=$(payload_field "$payload" '.session_id') || session=$$
  mine=$(ticket_path)
  ticket_write "$mine" "$(heavy_key_for "$cwd")" "$(strip_cd_prefix "$cmd")" waiting
  printf '%s' "$mine" > "$(session_ticket_file "$session")" 2>/dev/null

  if ! wait_for_head "$mine"; then
    rm -f "$mine"
    heavy_log "timed out waiting for the slot, running unqueued: $cmd"
    return 0
  fi
  ticket_write "$mine" "$(heavy_key_for "$cwd")" "$(strip_cd_prefix "$cmd")" running

  jq -nc --arg c "$HEAVY_SELF hold $(shell_quote "$cmd")" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",updatedInput:{command:$c}},systemMessage:"yimbot: holding the heavy-job slot"}'
}

cmd_post() {
  local payload session f
  payload=$(cat)
  session=$(payload_field "$payload" '.session_id') || return 0
  f=$(session_ticket_file "$session")
  [ -f "$f" ] || return 0
  rm -f "$(cat "$f" 2>/dev/null)" "$f" 2>/dev/null
  return 0
}

# Source-guard: sourcing loads the helpers, executing dispatches a subcommand.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  heavy_conf_load
  case ${1:-} in
    pre) cmd_pre ;;
    post) cmd_post ;;
    hold) shift; cmd_hold "${1:-}"; exit $? ;;
    *) echo "usage: heavy-queue.sh {pre|post|hold <cmd>|status [--json]}" >&2; exit 2 ;;
  esac
  exit 0
fi
