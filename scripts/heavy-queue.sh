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
#   post    PostToolUse hook. Drops the ticket this tool call took, unless the
#           hold it handed the ticket to is still running the command.
#   hold    Runs a command under the flock. What `pre` rewrites commands to.
#   status  Prints the queue and the api-tests stack owner, --json for machines.
#
# A second lock guards the api-tests stack: one per machine, since every
# worktree's stack shares a compose project name and a port range. It is a state
# file (stack.json) read and written under a short flock, because the stack
# outlives the command that started it.
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
  HEAVY_STACK_PATTERNS='task api-tests(:(up|restart))?([[:space:]]|$)|node ([^ ]+/)?(api-tests/)?scripts/run\.mjs( --[a-z-]+)* (all|up|restart)([[:space:]]|$)'
  HEAVY_STACK_DOWN_PATTERNS='task api-tests:down([[:space:]]|$)|node ([^ ]+/)?(api-tests/)?scripts/run\.mjs( --[a-z-]+)* down([[:space:]]|$)'
  HEAVY_PATTERNS="^(task (generate|gqlgen|build-all|test|test-integration|ci-local)|pnpm (run )?(build|typecheck|test)[a-z:]*|go build|go test|$HEAVY_STACK_PATTERNS)"
  HEAVY_WAIT_TIMEOUT=1200
  HEAVY_STACK_WAIT=600
  HEAVY_MIN_FREE_PCT=20
  HEAVY_STACK_PROJECT=api-tests
  HEAVY_STACK_PORT=31003
  HEAVY_MAX_JOB=1800
  # A 0.5s heartbeat needs a window wide enough to survive the loaded machine
  # this queue exists for. A dead waiter's ticket then delays others by up to
  # this long, which costs fairness only: the flock is what gates the work.
  HEAVY_STALE_WAIT=30
  [ -f "$HEAVY_CONF" ] && . "$HEAVY_CONF"
  # The conf is hand-edited. These feed arithmetic and flock -w, where a
  # garbage value makes flock refuse the invocation and skip the command it was
  # meant to queue, so fall back to the default rather than pass it on.
  [[ ${HEAVY_WAIT_TIMEOUT:-} =~ ^[0-9]+$ ]] || HEAVY_WAIT_TIMEOUT=1200
  [[ ${HEAVY_MAX_JOB:-} =~ ^[0-9]+$ ]] || HEAVY_MAX_JOB=1800
  [[ ${HEAVY_STALE_WAIT:-} =~ ^[0-9]+$ ]] || HEAVY_STALE_WAIT=30
  [[ ${HEAVY_STACK_WAIT:-} =~ ^[0-9]+$ ]] || HEAVY_STACK_WAIT=600
  [[ ${HEAVY_MIN_FREE_PCT:-} =~ ^[0-9]+$ ]] || HEAVY_MIN_FREE_PCT=20
  [[ ${HEAVY_STACK_PORT:-} =~ ^[0-9]+$ ]] || HEAVY_STACK_PORT=31003
  [ -n "${HEAVY_STACK_PROJECT:-}" ] || HEAVY_STACK_PROJECT=api-tests
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

# `timeout [opts] <duration>` in front of a command: drop the runner, its
# options (with the value -k and -s take), and the duration.
strip_timeout_prefix() {
  local cmd=$1 opt
  [[ $cmd =~ ^[[:space:]]*timeout[[:space:]]+(.*)$ ]] || { printf '%s' "$cmd"; return; }
  cmd=${BASH_REMATCH[1]}
  while [[ $cmd =~ ^(-[^[:space:]]+)[[:space:]]+(.*)$ ]]; do
    opt=${BASH_REMATCH[1]} cmd=${BASH_REMATCH[2]}
    case $opt in -k|-s|--kill-after|--signal) [[ $cmd =~ ^[^[:space:]]+[[:space:]]+(.*)$ ]] && cmd=${BASH_REMATCH[1]} ;; esac
  done
  [[ $cmd =~ ^[0-9.]+[smhd]?[[:space:]]+(.*)$ ]] && cmd=${BASH_REMATCH[1]}
  printf '%s' "$cmd"
}

# A command also reaches the hook behind an env assignment, inside a subshell,
# as the body of a `bash -c`, after a compound keyword (`if`, `do`, `{`), or
# under a runner (`time`, `timeout`, `nohup`). Peel every layer so both the
# match and the ticket see the real command rather than its wrapper.
unwrap_command() {
  local cmd=$1 prev=
  while [ "$cmd" != "$prev" ]; do
    prev=$cmd
    cmd=$(strip_cd_prefix "$cmd")
    [[ $cmd =~ ^[[:space:]]*(if|then|else|elif|do|while|until|time|nohup|!|\{)[[:space:]]+(.*)$ ]] && cmd=${BASH_REMATCH[2]}
    cmd=$(strip_timeout_prefix "$cmd")
    [[ $cmd =~ ^[[:space:]]*\((.*)\)[[:space:]]*$ ]] && cmd=${BASH_REMATCH[1]}
    [[ $cmd =~ ^[[:space:]]*(ba|z|)sh[[:space:]]+-c[[:space:]]+\"(.*)\"[[:space:]]*$ ]] && cmd=${BASH_REMATCH[2]}
    [[ $cmd =~ ^[[:space:]]*(ba|z|)sh[[:space:]]+-c[[:space:]]+\'(.*)\'[[:space:]]*$ ]] && cmd=${BASH_REMATCH[2]}
    while [[ $cmd =~ ^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+(.*)$ ]]; do
      cmd=${BASH_REMATCH[1]}
    done
  done
  printf '%s' "$cmd"
}

# grep matches line by line, so the ^ anchor in HEAVY_PATTERNS lands on every
# line of a heredoc body too. Drop the bodies before matching.
strip_heredocs() {
  printf '%s\n' "$1" | awk '
    delim != "" { if ($0 == delim) delim = ""; next }
    match($0, /(^|[^<])<<-?[[:space:]]*["'\'']?[A-Za-z_][A-Za-z0-9_]*["'\'']?/) {
      delim = substr($0, RSTART, RLENGTH)
      sub(/^[^<]?<<-?[[:space:]]*/, "", delim)
      gsub(/["'\'']/, "", delim)
    }
    { print }'
}

# One simple command per NUL-terminated record, split on ; | & && || and
# newlines. A separator inside quotes, backticks, a $( ) or a ( ) does not
# split, >& and &> are redirections, and an unquoted # ends the line. A record
# may span lines; the caller peels its wrappers.
split_commands() {
  printf '%s\n' "$1" | awk '
    function flush() { sub(/^[ \t\n]+/, "", seg); sub(/[ \t\n]+$/, "", seg); if (seg != "") printf "%s%c", seg, 0; seg = "" }
    {
      line = $0; n = length(line)
      for (i = 1; i <= n; i++) {
        c = substr(line, i, 1); nx = substr(line, i + 1, 1)
        if (q != "") {
          if (c == "\\" && q == "\"") { seg = seg c nx; i++; continue }
          if (c == q) q = ""
          seg = seg c; continue
        }
        if (c == "\\") { seg = seg c nx; i++; continue }
        if (c == "\"" || c == "\047" || c == "`") { q = c; seg = seg c; continue }
        if (c == "#" && (seg ~ /(^|[ \t\n])$/ || i == 1)) break
        if (c == "(") { depth++; seg = seg c; continue }
        if (c == ")") { if (depth > 0) depth--; seg = seg c; continue }
        if (depth > 0) { seg = seg c; continue }
        if (c == ";") { flush(); continue }
        if (c == "|") { flush(); if (nx == "|") i++; continue }
        if (c == "&") {
          if (nx == "&") { flush(); i++; continue }
          if (nx == ">" || substr(line, i - 1, 1) == ">") { seg = seg c; continue }
          flush(); continue
        }
        seg = seg c
      }
      if (q == "" && depth == 0) flush(); else seg = seg "\n"
    }
    END { flush() }'
}

# The first simple command in the chain that matches HEAVY_PATTERNS, peeled of
# its wrappers, or nothing. A session that runs `pgrep ...; task generate` is
# still running a heavy job. This is the one parse the hook does per command,
# so the reentrancy guards live here.
heavy_command() {
  [ -n "${YIMBOT_HEAVY_HELD:-}" ] && return 1
  command_matching "$HEAVY_PATTERNS" "$1"
}

# heavy_command's parse against any pattern, without the reentrancy guard.
command_matching() {
  local pattern=$1 seg inner
  case $2 in *heavy-queue.sh\ hold*) return 1 ;; esac
  while IFS= read -r -d '' seg; do
    inner=$(unwrap_command "$seg")
    if [[ $inner =~ $pattern ]]; then
      printf '%s' "$inner"
      return 0
    fi
    if [ "$inner" != "$seg" ] && command_matching "$pattern" "$inner"; then
      return 0
    fi
  done < <(split_commands "$(strip_heredocs "$2")")
  return 1
}

stack_command() {
  [ -n "${YIMBOT_HEAVY_HELD:-}" ] && return 1
  command_matching "^($HEAVY_STACK_PATTERNS)" "$1"
}

stack_down_command() {
  command_matching "^($HEAVY_STACK_DOWN_PATTERNS)" "$1" >/dev/null
}

is_heavy() {
  heavy_command "$1" >/dev/null
}

# What the board shows for a command on the queue: its heavy segment, or the
# whole unwrapped command for a hold of something cheap.
ticket_command() {
  heavy_command "$1" || unwrap_command "$1"
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
  local path=$1 key=$2 cmd=$3 state=$4 owner=${5:-0} tmp=$1.$$.tmp start=0
  [ "$owner" != 0 ] && start=$(proc_start "$owner")
  printf '{"key":"%s","cmd":"%s","state":"%s","owner":%s,"owner_start":%s,"since":%s}\n' \
    "$(json_escape "$key")" "$(json_escape "$cmd")" "$state" "$owner" "${start:-0}" "$(( $(date +%s%N) / 1000000 ))" \
    2>/dev/null > "$tmp" || { rm -f "$tmp" 2>/dev/null; return 1; }
  mv -f "$tmp" "$path" 2>/dev/null
}

# Field 22 of /proc/<pid>/stat, taken after the last ")" because comm may itself
# hold spaces and parentheses.
proc_start() {
  local stat
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || { proc_start_ps "$1"; return; }
  stat=${stat##*) }
  set -- $stat
  printf '%s' "${20:-}"
}

# macOS has no /proc. lstart is a date string, and the ticket stores owner_start
# as a bare JSON number, so reduce it to a checksum.
proc_start_ps() {
  local started
  started=$(ps -o lstart= -p "$1" 2>/dev/null)
  [ -n "${started//[[:space:]]/}" ] || return 1
  printf '%s' "$started" | cksum | cut -d' ' -f1
}

ticket_field() {
  local line
  line=$(cat "$1" 2>/dev/null) || return 1
  [[ $line =~ \"$2\":\"(([^\"\\]|\\.)*)\" ]] && printf '%s' "${BASH_REMATCH[1]}"
}

# since and owner are written as bare JSON numbers, so ticket_field's
# quoted-string regex cannot read them back.
ticket_num_field() {
  local line
  line=$(cat "$1" 2>/dev/null) || return 1
  [[ $line =~ \"$2\":([0-9]+) ]] && printf '%s' "${BASH_REMATCH[1]}"
}

# The owner is the process holding the lock, and it is the only thing that knows
# when the job is over. Claude Code returns a Bash call that outruns its 120s
# timeout and leaves the command running in the background, so neither the tool
# call nor a heartbeat can speak for a job that is still pegging the machine.
ticket_owner_alive() {
  local owner start
  owner=$(ticket_num_field "$1" owner) || return 1
  { [ -n "$owner" ] && [ "$owner" != 0 ] && kill -0 "$owner" 2>/dev/null; } || return 1
  # kill -0 cannot tell the owner from a stranger that inherited its recycled PID.
  start=$(ticket_num_field "$1" owner_start)
  [ -z "$start" ] || [ "$start" = 0 ] || [ "$start" = "$(proc_start "$owner")" ]
}

ticket_stale() {
  local state mtime age limit owner
  mtime=$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null) || return 0
  # A ticket naming an owner is answered by that process and nothing else: alive
  # means the job is still going however long it takes, gone means the ticket
  # died with it, whether or not its trap got the chance to run.
  owner=$(ticket_num_field "$1" owner)
  if [ -n "$owner" ] && [ "$owner" != 0 ]; then
    ! ticket_owner_alive "$1"
    return
  fi
  state=$(ticket_field "$1" state)
  age=$(( $(date +%s) - mtime ))
  limit=$HEAVY_STALE_WAIT
  [ "$state" = "running" ] && limit=$HEAVY_MAX_JOB
  [ "$age" -gt "$limit" ]
}

ticket_reap() {
  local t p
  for t in "$(queue_dir)"/*.json; do
    [ -e "$t" ] || continue
    ticket_stale "$t" && rm -f "$t"
  done
  for p in "$HEAVY_STATE_DIR"/current/*; do
    [ -e "$p" ] || continue
    [ -e "$(cat "$p" 2>/dev/null)" ] || rm -f "$p"
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

# The ticket belongs to this process from here on: it takes over the one pre
# handed it in HEAVY_TICKET, names itself the owner, and drops it on the way
# out. A hold reached by hand, or by a pre that gave up its place in line,
# arrives without one and writes its own, so `heavy status` and the board pane
# cannot report idle while it holds the machine. Ticket first, trap second,
# lock last: a ticket that cannot be written is not a reason to skip the lock.
hold_ticket() {
  # A ticket reaped between pre and here is gone for good, so rejoin at the back
  # rather than resurrect a path no other waiter is looking at any more.
  { [ -n "$HEAVY_TICKET" ] && [ -e "$HEAVY_TICKET" ]; } || HEAVY_TICKET=$(ticket_path)
  ticket_write "$HEAVY_TICKET" "$(heavy_key_for "$PWD")" "$(ticket_command "$1")" running "$$" || return 0
  # The path goes into the trap now, not at exit: this hold drops the ticket it
  # owns even if something reassigns HEAVY_TICKET in between.
  trap "rm -f $(shell_quote "$HEAVY_TICKET") 2>/dev/null" EXIT
  return 0
}

hold_unqueued() {
  local rc
  bash -c "$1"
  rc=$?
  [ -n "$2" ] && stack_settle "$2" "$rc"
  return $rc
}

cmd_hold() {
  local cmd=$1 rc lock stack_wt=
  # Checked before the held marker goes up, which would hide every match.
  stack_command "$cmd" >/dev/null && stack_wt=$(stack_worktree "$PWD")
  export YIMBOT_HEAVY_HELD=1
  # pre passes the ticket in as an environment assignment. Stop it there: a
  # nested hold that adopted this ticket would drop it when the inner command
  # exits, mid-job.
  export -n HEAVY_TICKET 2>/dev/null
  if ! command -v flock >/dev/null 2>&1; then
    heavy_log "flock missing, running unqueued"
    hold_unqueued "$cmd" "$stack_wt"
    return $?
  fi
  lock=$(lock_path)
  if ! : 2>/dev/null >> "$lock"; then
    heavy_log "cannot open the lock file, running unqueued: $cmd"
    hold_unqueued "$cmd" "$stack_wt"
    return $?
  fi
  hold_ticket "$cmd"
  [ -n "$stack_wt" ] && stack_mark_pending "$stack_wt" "$$"
  # -E 99 marks "could not take the lock in time" so nothing waits forever. A
  # command that legitimately exits 99 is indistinguishable here and gets run a
  # second time, which is the accepted cost of never blocking a session.
  flock -w "$HEAVY_MAX_JOB" -E 99 "$lock" bash -c "$cmd"
  rc=$?
  if [ "$rc" = 99 ]; then
    heavy_log "no lock after ${HEAVY_MAX_JOB}s, running unqueued: $cmd"
    hold_unqueued "$cmd" "$stack_wt"
    return $?
  fi
  [ -n "$stack_wt" ] && stack_settle "$stack_wt" "$rc"
  return $rc
}

# The exit status of a chain says nothing about the stack (`up; echo $?` always
# exits 0), so ask the stack itself.
# Up when it answers, released when the command failed. A command that exited 0
# with no stack yet (backgrounded, or still starting) keeps its pending claim
# for HEAVY_MAX_JOB, so a ten-minute build is not judged dead and handed over.
stack_settle() {
  if stack_alive; then
    stack_mark_up "$1"
  elif [ "$2" != 0 ]; then
    stack_release "$1"
  else
    stack_mark_pending "$1" 0
  fi
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

# Free memory as a whole percentage, empty when no source answers.
free_memory_pct() {
  local pct
  if [ "$(uname 2>/dev/null)" = Darwin ]; then
    pct=$(memory_pressure -Q 2>/dev/null | pct_from_memory_pressure)
    [ -n "$pct" ] && { printf '%s' "$pct"; return; }
    pct=$(vm_stat 2>/dev/null | pct_from_vm_stat "$(sysctl -n hw.memsize 2>/dev/null)")
    [ -n "$pct" ] && { printf '%s' "$pct"; return; }
  fi
  pct_from_meminfo /proc/meminfo
}

pct_from_memory_pressure() {
  sed -n 's/.*free percentage: *\([0-9]*\)%.*/\1/p' | head -1
}

pct_from_vm_stat() {
  awk -v total="${1:-0}" '
    /page size of/ { match($0, /page size of [0-9]+/); ps = substr($0, RSTART + 13, RLENGTH - 13) }
    /^Pages (free|inactive|speculative):/ { gsub(/\./, "", $NF); pages += $NF }
    END { if (total > 0 && ps > 0) printf "%d", pages * ps * 100 / total }'
}

pct_from_meminfo() {
  [ -r "$1" ] || return 1
  awk '
    /^MemTotal:/ { total = $2 }
    /^MemAvailable:/ { avail = $2 }
    END { if (total > 0 && avail != "") printf "%d", avail * 100 / total; else exit 1 }' "$1"
}

# True while free memory is below HEAVY_MIN_FREE_PCT. An unreadable reading never
# blocks: the gate exists to protect the machine, not to wedge sessions.
memory_low() {
  local free
  [ "$HEAVY_MIN_FREE_PCT" -gt 0 ] || return 1
  free=$(free_memory_pct 2>/dev/null)
  [[ $free =~ ^[0-9]+$ ]] || return 1
  HEAVY_FREE_NOW=$free
  [ "$free" -lt "$HEAVY_MIN_FREE_PCT" ]
}

stack_file() {
  mkdir -p "$HEAVY_STATE_DIR" 2>/dev/null
  printf '%s' "$HEAVY_STATE_DIR/stack.json"
}

# Runs a function under a short flock so two sessions cannot both claim a free
# stack. A missing flock or an unopenable lock file runs it unlocked: the stack
# wait is bounded either way.
with_stack_lock() {
  local lock=$HEAVY_STATE_DIR/stack.lock
  mkdir -p "$HEAVY_STATE_DIR" 2>/dev/null
  if command -v flock >/dev/null 2>&1 && : 2>/dev/null >> "$lock"; then
    ( flock -w 10 9 2>/dev/null; "$@" ) 9>> "$lock"
  else
    "$@"
  fi
}

# Is anything of the api-tests stack still up: a container in its compose
# project, or a listener on its first port (HEAVY_STACK_PROJECT, HEAVY_STACK_PORT).
stack_alive() {
  if [ -n "${HEAVY_STACK_PROBE:-}" ]; then
    bash -c "$HEAVY_STACK_PROBE" >/dev/null 2>&1
    return
  fi
  if command -v docker >/dev/null 2>&1 &&
    [ -n "$(docker ps -q --filter label=com.docker.compose.project=$HEAVY_STACK_PROJECT 2>/dev/null)" ]; then
    return 0
  fi
  ( exec 3<> /dev/tcp/127.0.0.1/$HEAVY_STACK_PORT ) 2>/dev/null
}

stack_write() {
  local file=$(stack_file) tmp
  tmp=$file.$$.tmp
  printf '{"key":"%s","worktree":"%s","state":"%s","pid":%s,"since":%s}\n' \
    "$(json_escape "$1")" "$(json_escape "$2")" "$3" "${4:-0}" "$(date +%s)" \
    2>/dev/null > "$tmp" || { rm -f "$tmp" 2>/dev/null; return 1; }
  mv -f "$tmp" "$file" 2>/dev/null
}

# A claim is stale when its worktree is gone, when a pending one lost the process
# bringing it up or outlived HEAVY_MAX_JOB, or when an up one has
# no containers or processes left.
stack_stale() {
  local f=$1 state wt pid since
  [ -f "$f" ] || return 0
  wt=$(ticket_field "$f" worktree)
  [ -d "$wt" ] || return 0
  state=$(ticket_field "$f" state)
  if [ "$state" = pending ]; then
    pid=$(ticket_num_field "$f" pid)
    since=$(ticket_num_field "$f" since)
    if [ -n "$pid" ] && [ "$pid" != 0 ]; then
      kill -0 "$pid" 2>/dev/null || return 0
    fi
    [ $(( $(date +%s) - ${since:-0} )) -gt "$HEAVY_MAX_JOB" ]
    return
  fi
  ! stack_alive
}

stack_reap() {
  local f=$(stack_file)
  [ -f "$f" ] && stack_stale "$f" && rm -f "$f" 2>/dev/null
  return 0
}

_stack_claim() {
  local wt=$1 key=$2 f=$(stack_file)
  stack_reap
  if [ -f "$f" ] && [ "$(ticket_field "$f" worktree)" != "$wt" ]; then
    ticket_field "$f" key
    return 1
  fi
  [ -f "$f" ] && return 0
  stack_write "$key" "$wt" pending 0
  return 0
}

# Take the stack for a worktree. Prints the owning key and fails when another
# worktree holds it. A write failure grants the claim rather than blocking.
stack_claim() {
  with_stack_lock _stack_claim "$1" "$2"
}

_stack_mark() {
  local f=$(stack_file) wt=$1 state=$2 pid=${3:-0}
  [ -f "$f" ] && [ "$(ticket_field "$f" worktree)" = "$wt" ] || return 0
  if [ "$state" = release ]; then
    rm -f "$f" 2>/dev/null
  else
    stack_write "$(ticket_field "$f" key)" "$wt" "$state" "$pid"
  fi
}

stack_mark_up() { with_stack_lock _stack_mark "$1" up 0; }
stack_mark_pending() { with_stack_lock _stack_mark "$1" pending "$2"; }
stack_release() { with_stack_lock _stack_mark "$1" release; }

# Poll for the stack until HEAVY_STACK_WAIT runs out. Prints the owner on timeout.
wait_for_stack() {
  local wt=$1 key=$2 deadline owner
  deadline=$(( $(date +%s) + HEAVY_STACK_WAIT ))
  while true; do
    owner=$(stack_claim "$wt" "$key") && return 0
    [ "$(date +%s)" -ge "$deadline" ] && { printf '%s' "${owner:-another worktree}"; return 1; }
    sleep 1
  done
}

stack_worktree() {
  git -C "$1" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$1"
}

# Poll until HEAVY_TICKET reaches the head. Touch it every pass: that heartbeat
# is what lets other waiters reap this ticket promptly if the session dies. A
# waiter reaped anyway writes a fresh ticket and keeps waiting, so losing the
# heartbeat race costs a place in line and never the serialization. HEAVY_TICKET
# is read and reassigned here, since rejoining means a new path.
wait_for_head() {
  local key=$1 cmd=$2 deadline=$(( $(date +%s) + HEAVY_WAIT_TIMEOUT ))
  HEAVY_WAIT_REASON=queue
  while true; do
    ticket_reap
    if [ "$(ticket_head)" = "$HEAVY_TICKET" ]; then
      memory_low || return 0
      HEAVY_WAIT_REASON=memory
    else
      HEAVY_WAIT_REASON=queue
    fi
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
  local payload cmd cwd call key stripped prefix stack_wt owner
  payload=$(cat)
  cmd=$(payload_field "$payload" '.tool_input.command') || return 0
  [ -n "$cmd" ] || return 0
  # A stack command queues even when an older conf's HEAVY_PATTERNS omits it.
  stripped=$(heavy_command "$cmd") || stripped=$(stack_command "$cmd") || return 0

  cwd=$(payload_field "$payload" '.cwd') || cwd=$PWD
  key=$(heavy_key_for "$cwd")
  # The stack check comes before the queue so a session waiting on another
  # worktree's stack holds no place in line while it waits.
  if stack_command "$cmd" >/dev/null; then
    stack_wt=$(stack_worktree "$cwd")
    if ! owner=$(wait_for_stack "$stack_wt" "$key"); then
      heavy_log "api-tests stack held by $owner, denying: $stripped"
      jq -nc --arg r "api-tests stack is held by $owner; wait or ask it to run task api-tests:down" \
        '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
      return 0
    fi
  fi
  # Losing the queue never costs the lock: every path below still rewrites the
  # command through hold. Dropping the handover with the ticket is what lets
  # hold write a fresh one for what it is about to run.
  HEAVY_TICKET=$(ticket_path)
  prefix=""
  if ! ticket_write "$HEAVY_TICKET" "$key" "$stripped" waiting; then
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
      # Hand hold the ticket to take over, read after the wait rather than
      # before it: a rejoin swaps the path, and handing over the old one has
      # hold rejoin at the back for no reason.
      prefix="HEAVY_TICKET=$(shell_quote "$HEAVY_TICKET") "
    else
      rm -f "$HEAVY_TICKET" 2>/dev/null
      [ -n "$call" ] && rm -f "$(call_ticket_file "$call")" 2>/dev/null
      if [ "$HEAVY_WAIT_REASON" = memory ]; then
        heavy_log "timed out waiting for free memory (${HEAVY_FREE_NOW:-?}% free, need ${HEAVY_MIN_FREE_PCT}%), holding without a place in line: $stripped"
      else
        heavy_log "timed out waiting for the slot, holding without a place in line: $stripped"
      fi
    fi
  fi

  jq -nc --arg c "$prefix$HEAVY_SELF hold $(shell_quote "$cmd")" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",updatedInput:{command:$c}},systemMessage:"yimbot: holding the heavy-job slot"}'
}

# down ran in this worktree: drop its claim once nothing of the stack is left.
stack_release_if_down() {
  stack_alive || stack_release "$1"
}

cmd_post() {
  local payload call f ticket pcmd pcwd
  payload=$(cat)
  pcmd=$(payload_field "$payload" '.tool_input.command') || pcmd=
  if [ -n "$pcmd" ] && stack_down_command "$pcmd"; then
    pcwd=$(payload_field "$payload" '.cwd') || pcwd=$PWD
    stack_release_if_down "$(stack_worktree "$pcwd")"
  fi
  call=$(payload_field "$payload" '.tool_use_id') || return 0
  [ -n "$call" ] || return 0
  f=$(call_ticket_file "$call")
  [ -f "$f" ] || return 0
  ticket=$(cat "$f" 2>/dev/null)
  rm -f "$f" 2>/dev/null
  # The call can return long before the command does: Claude Code moves one that
  # outruns its 120s timeout to the background, and every command this queue
  # exists for outruns it. So the ticket goes only if nothing is holding the
  # lock behind it; otherwise that hold's own exit is what clears it.
  ticket_owner_alive "$ticket" && return 0
  rm -f "$ticket" 2>/dev/null
  return 0
}

# The head ticket is the holder regardless of its recorded state: a ticket that
# reached the head is either running or about to be, and reporting it as waiting
# would show an empty slot that is not actually free.
# Reaping here makes status a writer, not a read-only observer, so anything
# polling it on a timer is also what keeps the queue tidy.
cmd_status() {
  local t first=1 running=null entries=() json now stack=null sf
  ticket_reap
  stack_reap
  sf=$(stack_file)
  if [ -f "$sf" ]; then
    stack=$(printf '{"key":"%s","worktree":"%s","state":"%s","since":%s}' \
      "$(ticket_field "$sf" key)" "$(ticket_field "$sf" worktree)" "$(ticket_field "$sf" state)" "$(ticket_num_field "$sf" since)")
  fi
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
    printf '{"running":%s,"waiting":%s,"stack":%s}\n' "$running" "$waiting" "$stack"
    return 0
  fi
  # An idle queue has nothing to feed jq: return here rather than leaning on
  # jq to tolerate the stray blank line an empty entries array would add.
  if [ "$running" = null ] && [ ${#entries[@]} -eq 0 ]; then
    stack_status_row "$stack"
    return 0
  fi
  now=$(( $(date +%s%N) / 1000000 ))
  printf '%s\n' "$running" ${entries[@]+"${entries[@]}"} | jq -r --argjson now "$now" '
    select(. != null)
    | ((($now - .since) / 1000 | floor) | if . < 0 then 0 else . end) as $s
    | (if $s < 60 then "\($s)s"
       elif $s < 3600 then "\($s / 60 | floor)m"
       else "\($s / 3600 | floor)h\($s % 3600 / 60 | floor)m" end) as $age
    | "\(.key)\t\($age)\t\(.cmd)"'
  stack_status_row "$stack"
}

# The stack owner as a last row, in the same key, age, text columns.
stack_status_row() {
  [ "$1" = null ] && return 0
  printf '%s' "$1" | jq -r --argjson now "$(( $(date +%s) ))" '
    "\(.key)\t\((($now - .since) / 60 | floor))m\tapi-tests stack (\(.state))"'
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
