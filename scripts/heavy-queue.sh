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
#   post    PostToolUse hook. Drops the ticket this tool call took.
#   hold    Runs a command under the flock. What `pre` rewrites commands to.
#   status  Prints the queue, --json for machines.
#
# Every failure path exits 0 and lets the command run unqueued.

set -uo pipefail

HEAVY_STATE_DIR=${HEAVY_STATE_DIR:-${XDG_RUNTIME_DIR:-/tmp}/yimbot}
HEAVY_CONF=${HEAVY_CONF:-$HOME/.config/yimbot/heavy-jobs.conf}
HEAVY_SELF=$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")
# The ticket this invocation owns. wait_for_head reassigns it when it rejoins.
HEAVY_TICKET=${HEAVY_TICKET:-}

# Defaults matching settings/heavy-jobs.conf, so a missing or partial conf still
# yields a working queue rather than an unset-variable crash in the hot path.
heavy_conf_load() {
  HEAVY_PATTERNS='^(task (generate|gqlgen|build-all|test|test-integration|ci-local)|pnpm (run )?(build|typecheck|test)[a-z:]*|go build|go test)'
  HEAVY_WAIT_TIMEOUT=1200
  HEAVY_MAX_JOB=1800
  # A 0.5s heartbeat needs a window wide enough to survive the loaded machine
  # this queue exists for. A dead waiter's ticket then delays others by up to
  # this long, which costs fairness only: the flock is what gates the work.
  HEAVY_STALE_WAIT=30
  [ -f "$HEAVY_CONF" ] && . "$HEAVY_CONF"
  # The conf is hand-edited. These three feed arithmetic and flock -w, where a
  # garbage value makes flock refuse the invocation and skip the command it was
  # meant to queue, so fall back to the default rather than pass it on.
  [[ ${HEAVY_WAIT_TIMEOUT:-} =~ ^[0-9]+$ ]] || HEAVY_WAIT_TIMEOUT=1200
  [[ ${HEAVY_MAX_JOB:-} =~ ^[0-9]+$ ]] || HEAVY_MAX_JOB=1800
  [[ ${HEAVY_STALE_WAIT:-} =~ ^[0-9]+$ ]] || HEAVY_STALE_WAIT=30
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

# A command also reaches the hook behind an env assignment, inside a subshell,
# or as the body of a `bash -c`. Peel every layer so both the match and the
# ticket see the real command rather than its wrapper.
unwrap_command() {
  local cmd=$1 prev=
  while [ "$cmd" != "$prev" ]; do
    prev=$cmd
    cmd=$(strip_cd_prefix "$cmd")
    [[ $cmd =~ ^[[:space:]]*\((.*)\)[[:space:]]*$ ]] && cmd=${BASH_REMATCH[1]}
    [[ $cmd =~ ^[[:space:]]*(ba|z|)sh[[:space:]]+-c[[:space:]]+\"(.*)\"[[:space:]]*$ ]] && cmd=${BASH_REMATCH[2]}
    [[ $cmd =~ ^[[:space:]]*(ba|z|)sh[[:space:]]+-c[[:space:]]+\'(.*)\'[[:space:]]*$ ]] && cmd=${BASH_REMATCH[2]}
    while [[ $cmd =~ ^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+(.*)$ ]]; do
      cmd=${BASH_REMATCH[1]}
    done
  done
  printf '%s' "$cmd"
}

is_heavy() {
  local cmd
  [ -n "${YIMBOT_HEAVY_HELD:-}" ] && return 1
  cmd=$(unwrap_command "$1")
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

# Write to a sibling and rename: truncating in place lets a concurrent status
# read see an empty or half-written file and print a jq parse error at the user.
# The 2>/dev/null comes first so a failing redirect on a full or unwritable
# state dir is silenced too, not just the printf.
ticket_write() {
  local path=$1 key=$2 cmd=$3 state=$4 tmp=$1.$$.tmp
  printf '{"key":"%s","cmd":"%s","state":"%s","since":%s}\n' \
    "$(json_escape "$key")" "$(json_escape "$cmd")" "$state" "$(( $(date +%s%N) / 1000000 ))" \
    2>/dev/null > "$tmp" || { rm -f "$tmp" 2>/dev/null; return 1; }
  mv -f "$tmp" "$path" 2>/dev/null
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

# A hold reached by hand, or by a pre that gave up its place in line, carries no
# ticket, so `heavy status` and the board pane would both report idle while it
# holds the machine. Ticket first, trap second, lock last: a ticket that cannot
# be written is not a reason to skip the lock.
hold_ticket() {
  [ -n "${YIMBOT_HEAVY_TICKETED:-}" ] && return 0
  HEAVY_TICKET=$(ticket_path)
  ticket_write "$HEAVY_TICKET" "$(heavy_key_for "$PWD")" "$(unwrap_command "$1")" running || return 0
  trap 'rm -f "$HEAVY_TICKET" 2>/dev/null' EXIT
  return 0
}

cmd_hold() {
  local cmd=$1 rc lock
  export YIMBOT_HEAVY_HELD=1
  if ! command -v flock >/dev/null 2>&1; then
    heavy_log "flock missing, running unqueued"
    bash -c "$cmd"
    return $?
  fi
  lock=$(lock_path)
  if ! : 2>/dev/null >> "$lock"; then
    heavy_log "cannot open the lock file, running unqueued: $cmd"
    bash -c "$cmd"
    return $?
  fi
  hold_ticket "$cmd"
  # -E 99 marks "could not take the lock in time" so nothing waits forever. A
  # command that legitimately exits 99 is indistinguishable here and gets run a
  # second time, which is the accepted cost of never blocking a session.
  flock -w "$HEAVY_MAX_JOB" -E 99 "$lock" bash -c "$cmd"
  rc=$?
  if [ "$rc" = 99 ]; then
    heavy_log "no lock after ${HEAVY_MAX_JOB}s, running unqueued: $cmd"
    bash -c "$cmd"
    return $?
  fi
  return $rc
}

heavy_log() {
  printf '[%s] heavy-queue: %s\n' "$(date '+%H:%M:%S')" "$*" 2>/dev/null >> "$HEAVY_STATE_DIR/queue.log" || true
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

# Keyed on tool_use_id, not session_id: one session issues several Bash calls at
# once, so a session-keyed file has them all overwriting and deleting each
# other's tickets. A tool call is exactly the lifetime of one ticket.
call_ticket_file() {
  local d=$HEAVY_STATE_DIR/current
  mkdir -p "$d" 2>/dev/null
  printf '%s/%s' "$d" "${1//[^A-Za-z0-9_-]/_}"
}

# Point this tool call's pairing file at whatever HEAVY_TICKET is now. Call it
# again after every wait: a rejoin swaps the ticket path, and a pairing file
# left on the old one has post delete nothing and leak the live ticket.
pair_call_ticket() {
  [ -n "$1" ] || return 0
  printf '%s' "$HEAVY_TICKET" 2>/dev/null > "$(call_ticket_file "$1")"
}

# Poll until HEAVY_TICKET reaches the head. Touch it every pass: that heartbeat
# is what lets other waiters reap this ticket promptly if the session dies. A
# waiter reaped anyway writes a fresh ticket and keeps waiting, so losing the
# heartbeat race costs a place in line and never the serialization. HEAVY_TICKET
# is read and reassigned here, since rejoining means a new path.
wait_for_head() {
  local key=$1 cmd=$2 deadline=$(( $(date +%s) + HEAVY_WAIT_TIMEOUT ))
  while true; do
    ticket_reap
    [ "$(ticket_head)" = "$HEAVY_TICKET" ] && return 0
    [ "$(date +%s)" -ge "$deadline" ] && return 1
    if [ -e "$HEAVY_TICKET" ]; then
      touch "$HEAVY_TICKET" 2>/dev/null
    else
      heavy_log "ticket reaped while waiting, rejoining at the back: $cmd"
      HEAVY_TICKET=$(ticket_path)
      ticket_write "$HEAVY_TICKET" "$key" "$cmd" waiting || return 1
    fi
    sleep 0.5
  done
}

cmd_pre() {
  local payload cmd cwd call key stripped prefix
  payload=$(cat)
  cmd=$(payload_field "$payload" '.tool_input.command') || return 0
  [ -n "$cmd" ] || return 0
  is_heavy "$cmd" || return 0

  cwd=$(payload_field "$payload" '.cwd') || cwd=$PWD
  key=$(heavy_key_for "$cwd")
  stripped=$(unwrap_command "$cmd")
  # Losing the queue never costs the lock: every path below still rewrites the
  # command through hold. Dropping the flag with the ticket is what lets hold
  # write a fresh one for what it is about to run.
  prefix="YIMBOT_HEAVY_TICKETED=1 "
  HEAVY_TICKET=$(ticket_path)
  if ! ticket_write "$HEAVY_TICKET" "$key" "$stripped" waiting; then
    prefix=""
    heavy_log "cannot write a ticket, holding without a place in line: $stripped"
  else
    call=$(payload_field "$payload" '.tool_use_id') || call=
    if [ -n "$call" ]; then
      pair_call_ticket "$call"
    else
      heavy_log "payload carries no tool_use_id, leaving the ticket to the stale reap: $stripped"
    fi
    if wait_for_head "$key" "$stripped"; then
      pair_call_ticket "$call"
      ticket_write "$HEAVY_TICKET" "$key" "$stripped" running
    else
      rm -f "$HEAVY_TICKET" 2>/dev/null
      [ -n "$call" ] && rm -f "$(call_ticket_file "$call")" 2>/dev/null
      prefix=""
      heavy_log "timed out waiting for the slot, holding without a place in line: $stripped"
    fi
  fi

  jq -nc --arg c "$prefix$HEAVY_SELF hold $(shell_quote "$cmd")" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",updatedInput:{command:$c}},systemMessage:"yimbot: holding the heavy-job slot"}'
}

cmd_post() {
  local payload call f
  payload=$(cat)
  call=$(payload_field "$payload" '.tool_use_id') || return 0
  [ -n "$call" ] || return 0
  f=$(call_ticket_file "$call")
  [ -f "$f" ] || return 0
  rm -f "$(cat "$f" 2>/dev/null)" "$f" 2>/dev/null
  return 0
}

# since is written as a bare JSON number, so ticket_field's quoted-string
# regex cannot read it back.
ticket_num_field() {
  local line
  line=$(cat "$1" 2>/dev/null) || return 1
  [[ $line =~ \"$2\":([0-9]+) ]] && printf '%s' "${BASH_REMATCH[1]}"
}

# The head ticket is the holder regardless of its recorded state: a ticket that
# reached the head is either running or about to be, and reporting it as waiting
# would show an empty slot that is not actually free.
# Reaping here makes status a writer, not a read-only observer, so anything
# polling it on a timer is also what keeps the queue tidy.
cmd_status() {
  local t first=1 running=null entries=() json now
  ticket_reap
  for t in $(printf '%s\n' "$(queue_dir)"/*.json 2>/dev/null | sort); do
    [ -e "$t" ] || continue
    json=$(printf '{"key":"%s","cmd":"%s","since":%s}' \
      "$(ticket_field "$t" key)" "$(ticket_field "$t" cmd)" "$(ticket_num_field "$t" since)")
    if [ "$first" = 1 ]; then
      running=$json
      first=0
      continue
    fi
    entries+=("$json")
  done
  local waiting
  waiting=$(IFS=,; printf '[%s]' "${entries[*]:-}")
  if [ "${1:-}" = "--json" ]; then
    printf '{"running":%s,"waiting":%s}\n' "$running" "$waiting"
    return 0
  fi
  # An idle queue has nothing to feed jq: return here rather than leaning on
  # jq to tolerate the stray blank line an empty entries array would add.
  [ "$running" = null ] && [ ${#entries[@]} -eq 0 ] && return 0
  now=$(( $(date +%s%N) / 1000000 ))
  printf '%s\n' "$running" "${entries[@]}" | jq -r --argjson now "$now" '
    select(. != null)
    | ((($now - .since) / 1000 | floor) | if . < 0 then 0 else . end) as $s
    | (if $s < 60 then "\($s)s"
       elif $s < 3600 then "\($s / 60 | floor)m"
       else "\($s / 3600 | floor)h\($s % 3600 / 60 | floor)m" end) as $age
    | "\(.key)\t\($age)\t\(.cmd)"'
}

# Source-guard: sourcing loads the helpers, executing dispatches a subcommand.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  heavy_conf_load
  case ${1:-} in
    pre) cmd_pre ;;
    post) cmd_post ;;
    hold) shift; cmd_hold "${1:-}"; exit $? ;;
    status) shift; cmd_status "${1:-}" ;;
    *) echo "usage: heavy-queue.sh {pre|post|hold <cmd>|status [--json]}" >&2; exit 2 ;;
  esac
  exit 0
fi
