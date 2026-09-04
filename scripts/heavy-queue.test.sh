#!/bin/bash
# Unit tests for scripts/heavy-queue.sh. Sourcing loads the helpers WITHOUT
# dispatching a subcommand (source-guard), so each one is testable alone.
set -u
export HEAVY_STATE_DIR=$(mktemp -d)
export HEAVY_CONF="$(cd "$(dirname "$0")" && pwd)/../settings/heavy-jobs.conf"
source "$(dirname "$0")/heavy-queue.sh"

fail=0
assert_eq() { if [ "$1" != "$2" ]; then echo "FAIL: $3 - got [$1] want [$2]"; fail=1; fi; }
assert_defined() { if ! declare -F "$1" >/dev/null; then echo "FAIL: $1 not defined after sourcing"; fail=1; fi; }
assert_ok() { if ! "$@"; then echo "FAIL: expected success: $*"; fail=1; fi; }
assert_fails() { if "$@"; then echo "FAIL: expected failure: $*"; fail=1; fi; }

assert_defined heavy_conf_load
assert_defined strip_cd_prefix
assert_defined is_heavy
assert_defined unwrap_command

heavy_conf_load

# The shipped conf supplies every tunable.
assert_eq "$HEAVY_WAIT_TIMEOUT" "1200" "wait timeout from conf"
assert_eq "$HEAVY_MAX_JOB" "1800" "max job from conf"
assert_eq "$HEAVY_STALE_WAIT" "30" "stale wait default"

# Sessions prefix commands with a cd into the worktree; strip it before matching.
assert_eq "$(strip_cd_prefix 'cd /home/ymbo/Work/worktrees/eng-1 && task generate')" "task generate" "strips one cd prefix"
assert_eq "$(strip_cd_prefix 'cd /a && cd /b && go build ./...')" "go build ./..." "strips a chained cd prefix"
assert_eq "$(strip_cd_prefix 'task generate')" "task generate" "leaves a bare command alone"

# Heavy commands queue.
assert_ok is_heavy 'task generate'
assert_ok is_heavy 'cd /home/ymbo/Work/worktrees/eng-1 && task generate'
assert_ok is_heavy 'task build-all'
assert_ok is_heavy 'pnpm build'
assert_ok is_heavy 'pnpm run typecheck'
assert_ok is_heavy 'go test ./...'

# Cheap commands do not.
assert_fails is_heavy 'git status'
assert_fails is_heavy 'ls -la'
assert_fails is_heavy 'echo task generate'
assert_fails is_heavy 'cat Taskfile.yaml'

# Commands reach the hook wrapped: an env assignment, a subshell, or a `bash -c`
# around the real work. Unwrap before matching, or the queue sees none of them.
assert_eq "$(unwrap_command 'CGO_ENABLED=0 go build ./...')" "go build ./..." "strips an env assignment"
assert_eq "$(unwrap_command 'GOOS=linux GOFLAGS=-mod=mod go build ./...')" "go build ./..." "strips a run of env assignments"
assert_eq "$(unwrap_command 'cd /a && CGO_ENABLED=0 go build ./...')" "go build ./..." "strips a cd then an env assignment"
assert_eq "$(unwrap_command '(cd api && go build ./...)')" "go build ./..." "strips a subshell"
assert_eq "$(unwrap_command 'bash -c "go build ./..."')" "go build ./..." "strips a bash -c wrapper"
assert_eq "$(unwrap_command "sh -c 'go build ./...'")" "go build ./..." "strips an sh -c wrapper"
assert_eq "$(unwrap_command 'go build ./...')" "go build ./..." "leaves an unwrapped command alone"
assert_ok is_heavy 'CGO_ENABLED=0 go build ./...'
assert_ok is_heavy '(cd api && go build ./...)'
assert_ok is_heavy 'bash -c "go build ./..."'

# gqlgen is the codegen step this queue exists for, in every form a session runs
# it: the task wrapper, the module through `go run`, and the bare binary.
assert_ok is_heavy 'task api:gqlgen'
assert_ok is_heavy 'go run github.com/99designs/gqlgen generate'
assert_ok is_heavy 'gqlgen generate'

# `go run` otherwise stays out: it is usually serve-graphql, which never exits.
assert_fails is_heavy 'go run ./cmd/serve-graphql'

# The config flag takes its value with a space as often as with an `=`.
assert_ok is_heavy 'graphql-codegen --config codegen.ts'
assert_ok is_heavy 'graphql-codegen --config=codegen.ts'
assert_fails is_heavy 'graphql-codegen --watch'

# A command already holding the slot must not queue behind itself: the flock is
# not reentrant, so a nested match would deadlock against its own parent.
assert_fails env YIMBOT_HEAVY_HELD=1 bash -c "source '$(dirname "$0")/heavy-queue.sh'; heavy_conf_load; is_heavy 'task generate'"

# Nor may an already-wrapped command be wrapped twice, which is what happens if
# Claude copies a rewritten command out of its own transcript.
assert_fails is_heavy "/home/ymbo/.config/yimbot/heavy-queue.sh hold 'task generate'"

# --- ticket primitives ---
assert_defined queue_dir
assert_defined ticket_path
assert_defined ticket_write
assert_defined ticket_field
assert_defined ticket_stale
assert_defined ticket_reap
assert_defined ticket_head

QD=$(queue_dir)
assert_eq "$(dirname "$QD")" "$HEAVY_STATE_DIR" "queue dir sits under the state dir"
assert_ok test -d "$QD"

rm -f "$QD"/*.json

# A ticket round-trips its fields, including a command carrying quotes.
T1=$(ticket_path)
ticket_write "$T1" "ENG-1" "task generate" waiting
assert_eq "$(ticket_field "$T1" key)" "ENG-1" "ticket key round-trips"
assert_eq "$(ticket_field "$T1" cmd)" "task generate" "ticket cmd round-trips"
assert_eq "$(ticket_field "$T1" state)" "waiting" "ticket state round-trips"
T_Q=$(ticket_path)
ticket_write "$T_Q" "ENG-Q" 'echo "hi"' waiting
assert_eq "$(ticket_field "$T_Q" cmd)" 'echo \"hi\"' "a quoted cmd stays escaped in the field"
rm -f "$T_Q"

# A rewrite is atomic, so a concurrent status read never sees a half-written
# ticket and never prints a jq parse error at the user.
ATOMIC=$(ticket_path)
ticket_write "$ATOMIC" "ENG-4" "task generate" waiting
( for _ in $(seq 1 300); do ticket_write "$ATOMIC" "ENG-4" "task generate --with-a-longer-command-line-to-widen-the-write" running; done ) &
ATOMIC_WRITER=$!
ATOMIC_BAD=0
# read is a builtin, so the reader samples often enough to land in the window a
# truncating write leaves open. jq would be too slow to catch it.
while kill -0 "$ATOMIC_WRITER" 2>/dev/null; do
  ATOMIC_LINE=""
  read -r ATOMIC_LINE < "$ATOMIC" 2>/dev/null
  case $ATOMIC_LINE in *'"since":'[0-9]*'}') ;; *) ATOMIC_BAD=$(( ATOMIC_BAD + 1 )) ;; esac
done
wait "$ATOMIC_WRITER"
assert_eq "$ATOMIC_BAD" "0" "a concurrent reader never sees a half-written ticket"
assert_eq "$(ls -1 "$(queue_dir)" | wc -l | tr -d ' ')" "2" "ticket_write leaves no temp file behind"
rm -f "$ATOMIC"

# Head is the oldest live ticket, so the queue is FIFO.
T2=$(ticket_path)
ticket_write "$T2" "ENG-2" "pnpm build" waiting
assert_eq "$(ticket_head)" "$T1" "oldest ticket is head"

# A waiting ticket heartbeats; one that stops is stale within seconds.
touch -d "@$(( $(date +%s) - 60 ))" "$T1"
assert_ok ticket_stale "$T1"
assert_fails ticket_stale "$T2"

# A running ticket is not stale until HEAVY_MAX_JOB, because a real build is
# quiet for far longer than a waiter's heartbeat interval.
T3=$(ticket_path)
ticket_write "$T3" "ENG-3" "task build-all" running
touch -d "@$(( $(date +%s) - 60 ))" "$T3"
assert_fails ticket_stale "$T3"
touch -d "@$(( $(date +%s) - HEAVY_MAX_JOB - 60 ))" "$T3"
assert_ok ticket_stale "$T3"

# Reaping clears the stale ones and promotes the next live ticket to head.
ticket_reap
assert_fails test -f "$T1"
assert_fails test -f "$T3"
assert_eq "$(ticket_head)" "$T2" "head advances after a reap"
rm -f "$QD"/*.json
assert_eq "$(ticket_head)" "" "empty queue has no head"

# heavy_key_for extracts board keys from branches, handling any case consistently.
# Create a throwaway repo to test mixed-case branches.
TEST_REPO=$(mktemp -d)
git init "$TEST_REPO" >/dev/null 2>&1
git -C "$TEST_REPO" config user.email "test@test" && git -C "$TEST_REPO" config user.name "Test"
git -C "$TEST_REPO" commit --allow-empty -m "init" >/dev/null 2>&1
git -C "$TEST_REPO" checkout -b "eng-1925-foo" >/dev/null 2>&1
assert_eq "$(heavy_key_for "$TEST_REPO")" "ENG-1925" "lowercase branch keys correctly"
git -C "$TEST_REPO" checkout -b "Eng-1926-bar" >/dev/null 2>&1
assert_eq "$(heavy_key_for "$TEST_REPO")" "ENG-1926" "mixed-case branch keys correctly"
git -C "$TEST_REPO" checkout -b "sc-99-baz" >/dev/null 2>&1
assert_eq "$(heavy_key_for "$TEST_REPO")" "SC-99" "sc- prefix keys correctly"
rm -rf "$TEST_REPO"

# An unrecognizable cwd still yields a usable key rather than an empty one.
assert_eq "$(heavy_key_for /nonexistent)" "?" "unknown cwd keys as ?"

# --- hold ---
assert_defined cmd_hold

# Exit status is the command's, not flock's.
assert_eq "$(cmd_hold 'echo held'; echo "rc=$?")" "held
rc=0" "hold passes stdout and a zero status through"
assert_eq "$(cmd_hold 'exit 7' >/dev/null 2>&1; echo $?)" "7" "hold propagates a non-zero status"

# The held command sees the guard, so a nested match cannot deadlock on the
# non-reentrant lock.
assert_eq "$(cmd_hold 'echo $YIMBOT_HEAVY_HELD')" "1" "hold marks the command as holding the slot"

# Three concurrent holds serialize: no start is logged between another's
# start and finish.
SERIAL_LOG=$(mktemp)
for i in 1 2 3; do
  ( bash "$(dirname "$0")/heavy-queue.sh" hold "printf 'start-$i\n' >> $SERIAL_LOG; sleep 0.3; printf 'end-$i\n' >> $SERIAL_LOG" ) &
done
wait
assert_eq "$(awk 'NR%2==1{if($0 !~ /^start-/) bad=1} NR%2==0{if($0 !~ /^end-/) bad=1} END{print bad+0}' "$SERIAL_LOG")" "0" "concurrent holds never interleave"
assert_eq "$(wc -l < "$SERIAL_LOG" | tr -d ' ')" "6" "every held command ran"
rm -f "$SERIAL_LOG"

# A hand-run hold is invisible to `heavy status` and to the board pane unless it
# writes its own ticket, so both would claim idle while it holds the machine.
rm -f "$(queue_dir)"/*.json
assert_eq "$(cmd_hold "ls -1 $(queue_dir)/*.json 2>/dev/null | wc -l | tr -d ' '")" "1" "a hand-run hold writes its own ticket"
assert_eq "$(ls -1 "$(queue_dir)" | wc -l | tr -d ' ')" "0" "the hold ticket goes away when the hold exits"

# pre already wrote a ticket for the session path, so hold must not add a second.
assert_eq "$(YIMBOT_HEAVY_TICKETED=1 cmd_hold "ls -1 $(queue_dir)/*.json 2>/dev/null | wc -l | tr -d ' '")" "0" "hold does not double-ticket behind pre"
rm -f "$(queue_dir)"/*.json

# The conf is hand-edited, and the tunables feed arithmetic and flock -w, where
# a garbage value would make flock refuse the whole invocation and skip the
# command rather than queue it.
BAD_CONF=$(mktemp)
printf 'HEAVY_MAX_JOB=abc\nHEAVY_WAIT_TIMEOUT=\nHEAVY_STALE_WAIT=-1\n' > "$BAD_CONF"
assert_eq "$(HEAVY_CONF="$BAD_CONF" bash "$(dirname "$0")/heavy-queue.sh" hold 'echo still-ran' 2>/dev/null)" "still-ran" "a garbage conf value never skips the command"
assert_eq "$(HEAVY_CONF="$BAD_CONF" bash "$(dirname "$0")/heavy-queue.sh" hold 'exit 7' >/dev/null 2>&1; echo $?)" "7" "a garbage conf value still returns the command's status"
BAD_ERR=$(HEAVY_CONF="$BAD_CONF" bash "$(dirname "$0")/heavy-queue.sh" hold 'echo still-ran' 2>&1 >/dev/null)
assert_eq "$BAD_ERR" "" "a garbage conf value leaks no flock error to stderr"
rm -f "$BAD_CONF" "$(queue_dir)"/*.json

# A lock it cannot take inside HEAVY_MAX_JOB runs the command anyway, because a
# wedged queue must never block a session.
flock "$(lock_path)" sleep 3 &
LOCK_HOLDER=$!
sleep 0.2
assert_eq "$(HEAVY_MAX_JOB=1 cmd_hold 'echo ran-anyway' 2>/dev/null)" "ran-anyway" "hold runs the command when the lock never frees up"
kill "$LOCK_HOLDER" 2>/dev/null
wait "$LOCK_HOLDER" 2>/dev/null
rm -f "$(queue_dir)"/*.json

# --- pre / post ---
assert_defined payload_field
assert_defined wait_for_head
assert_defined cmd_pre
assert_defined cmd_post

rm -f "$(queue_dir)"/*.json

# A cheap command produces no decision and no ticket: the hot path must stay
# silent so Claude Code runs the command exactly as written.
PRE_OUT=$(printf '%s' '{"session_id":"s1","cwd":"/tmp","tool_name":"Bash","tool_input":{"command":"git status"}}' | cmd_pre)
assert_eq "$PRE_OUT" "" "a cheap command yields no decision"
assert_eq "$(ls -1 "$(queue_dir)" | wc -l | tr -d ' ')" "0" "a cheap command writes no ticket"

# A heavy command on an empty queue is allowed straight through, rewritten to
# run under hold.
PRE_OUT=$(printf '%s' '{"session_id":"s2","cwd":"/tmp","tool_name":"Bash","tool_input":{"command":"task generate"}}' | cmd_pre)
assert_eq "$(printf '%s' "$PRE_OUT" | jq -r '.hookSpecificOutput.permissionDecision')" "allow" "a heavy command is allowed"
assert_eq "$(printf '%s' "$PRE_OUT" | jq -r '.hookSpecificOutput.updatedInput.command')" "YIMBOT_HEAVY_TICKETED=1 $HEAVY_SELF hold 'task generate'" "the command is rewritten through hold"
assert_eq "$(ls -1 "$(queue_dir)" | wc -l | tr -d ' ')" "1" "a heavy command leaves a running ticket"
assert_eq "$(ticket_field "$(ticket_head)" state)" "running" "the head ticket is marked running"

# Quoting is what breaks a command rewrite, so test the quoter directly.
assert_defined shell_quote
assert_eq "$(eval "printf '%s' $(shell_quote "it's fine")")" "it's fine" "shell_quote survives a single quote"
DQ_INPUT='a "b" c'
assert_eq "$(eval "printf '%s' $(shell_quote "$DQ_INPUT")")" "$DQ_INPUT" "shell_quote survives double quotes"
assert_eq "$(eval "printf '%s' $(shell_quote 'a $(rm -rf /) b')")" 'a $(rm -rf /) b' "shell_quote defuses command substitution"

hook_payload() {
  printf '{"session_id":"%s","tool_use_id":"%s","cwd":"/tmp","tool_name":"Bash","tool_input":{"command":"%s"}}' "$1" "$2" "$3"
}

# post removes only this tool call's ticket.
rm -f "$(queue_dir)"/*.json
hook_payload s4 tu_a 'task generate' | cmd_pre > /dev/null
OTHER=$(ticket_path); ticket_write "$OTHER" "ENG-9" "pnpm build" waiting
hook_payload s4 tu_a 'task generate' | cmd_post
assert_eq "$(ls -1 "$(queue_dir)" | wc -l | tr -d ' ')" "1" "post drops one ticket"
assert_eq "$(ticket_field "$(ticket_head)" key)" "ENG-9" "post left the other call's ticket alone"
rm -f "$(queue_dir)"/*.json

# One session issues several Bash calls at once, so a cheap call finishing first
# must not drop the heavy call's ticket out from under it.
hook_payload s5 tu_heavy 'task generate' | cmd_pre > /dev/null
hook_payload s5 tu_cheap 'ls -la' | cmd_pre > /dev/null
hook_payload s5 tu_cheap 'ls -la' | cmd_post
assert_eq "$(ls -1 "$(queue_dir)" | wc -l | tr -d ' ')" "1" "a cheap call's post leaves the heavy call's ticket alone"
assert_eq "$(ticket_field "$(ticket_head)" cmd)" "task generate" "the surviving ticket is the heavy call's"
hook_payload s5 tu_heavy 'task generate' | cmd_post
assert_eq "$(ls -1 "$(queue_dir)" | wc -l | tr -d ' ')" "0" "the heavy call's own post clears its ticket"

# Two heavy calls in one batch share a session_id, so each must clean up the
# ticket it wrote rather than whichever was written last.
hook_payload s6 tu_one 'task generate' | cmd_pre > /dev/null
SECOND_OUT=$(mktemp)
( hook_payload s6 tu_two 'pnpm build' | bash "$(dirname "$0")/heavy-queue.sh" pre > "$SECOND_OUT" ) &
SECOND_PID=$!
for _ in $(seq 1 100); do
  [ "$(ls -1 "$(queue_dir)"/*.json 2>/dev/null | wc -l | tr -d ' ')" -ge 2 ] && break
  sleep 0.1
done
hook_payload s6 tu_one 'task generate' | cmd_post
wait "$SECOND_PID"
assert_eq "$(jq -r '.hookSpecificOutput.permissionDecision' < "$SECOND_OUT")" "allow" "the second heavy call gets the slot once the first releases"
assert_eq "$(ls -1 "$(queue_dir)" | wc -l | tr -d ' ')" "1" "the first call's post left the second call's ticket alone"
assert_eq "$(ticket_field "$(ticket_head)" cmd)" "pnpm build" "the surviving ticket is the second call's"
hook_payload s6 tu_two 'pnpm build' | cmd_post
assert_eq "$(ls -1 "$(queue_dir)" | wc -l | tr -d ' ')" "0" "the second call's own post clears its ticket"
rm -f "$SECOND_OUT" "$(queue_dir)"/*.json "$HEAVY_STATE_DIR/current"/*

# A payload carrying no tool_use_id cannot pair, so pre writes no pairing file
# rather than one that would delete somebody else's ticket.
printf '%s' '{"session_id":"s7","cwd":"/tmp","tool_name":"Bash","tool_input":{"command":"task generate"}}' | cmd_pre > /dev/null
assert_eq "$(ls -1 "$HEAVY_STATE_DIR/current" 2>/dev/null | wc -l | tr -d ' ')" "0" "an unpairable payload writes no pairing file"
rm -f "$(queue_dir)"/*.json

# Being reaped mid-wait costs a place in line, never the serialization: the
# waiter writes a fresh ticket and keeps waiting.
BLOCKER=$(ticket_path); ticket_write "$BLOCKER" "ENG-8" "task build-all" running
HEAVY_TICKET=$(ticket_path); ticket_write "$HEAVY_TICKET" "ENG-7" "task generate" waiting
OLD_TICKET=$HEAVY_TICKET
rm -f "$HEAVY_TICKET"
( sleep 0.8; rm -f "$BLOCKER" ) &
HEAVY_WAIT_TIMEOUT=10 wait_for_head "ENG-7" "task generate"
REJOIN_RC=$?
wait
assert_eq "$REJOIN_RC" "0" "a reaped waiter rejoins the queue and still gets the slot"
assert_fails test "$HEAVY_TICKET" = "$OLD_TICKET"
assert_ok test -e "$HEAVY_TICKET"
rm -f "$(queue_dir)"/*.json

# A rejoin replaces the ticket path, so the pairing file has to follow it or
# post deletes a path that is already gone and the live ticket sits at the head
# until HEAVY_MAX_JOB, starving every other waiter.
rm -f "$(queue_dir)"/*.json "$HEAVY_STATE_DIR/current"/*
BLOCKER=$(ticket_path); ticket_write "$BLOCKER" "ENG-8" "task build-all" running
REJOIN_OUT=$(mktemp)
( hook_payload s12 tu_rejoin 'go build ./...' | bash "$(dirname "$0")/heavy-queue.sh" pre > "$REJOIN_OUT" ) &
REJOIN_PID=$!
for _ in $(seq 1 100); do
  [ "$(ls -1 "$(queue_dir)"/*.json 2>/dev/null | wc -l | tr -d ' ')" -ge 2 ] && break
  sleep 0.1
done
for REJOIN_T in "$(queue_dir)"/*.json; do [ "$REJOIN_T" = "$BLOCKER" ] || rm -f "$REJOIN_T"; done
for _ in $(seq 1 100); do
  [ "$(ls -1 "$(queue_dir)"/*.json 2>/dev/null | wc -l | tr -d ' ')" -ge 2 ] && break
  sleep 0.1
done
rm -f "$BLOCKER"
wait "$REJOIN_PID"
assert_eq "$(jq -r '.hookSpecificOutput.permissionDecision' < "$REJOIN_OUT")" "allow" "a rejoined waiter still gets a decision"
hook_payload s12 tu_rejoin 'go build ./...' | cmd_post
assert_eq "$(ls -1 "$(queue_dir)" | wc -l | tr -d ' ')" "0" "post clears the ticket a rejoin replaced"
rm -f "$REJOIN_OUT" "$(queue_dir)"/*.json

# Waiting behind a live ticket times out rather than hanging forever.
BLOCKER=$(ticket_path); ticket_write "$BLOCKER" "ENG-8" "task build-all" running
MINE=$(ticket_path); ticket_write "$MINE" "ENG-7" "task generate" waiting
assert_fails env HEAVY_WAIT_TIMEOUT=1 bash -c "source '$(dirname "$0")/heavy-queue.sh'; heavy_conf_load; HEAVY_WAIT_TIMEOUT=1; HEAVY_TICKET='$MINE'; wait_for_head 'ENG-7' 'task generate'"
rm -f "$(queue_dir)"/*.json

# Giving up on the queue costs the place in line, never the lock: the timeout
# path still rewrites the command through hold, and drops its ticket so hold
# writes a fresh one for what it is about to run.
BLOCKER=$(ticket_path); ticket_write "$BLOCKER" "ENG-8" "task build-all" running
TIMEOUT_OUT=$(hook_payload s8 tu_slow 'task generate' | HEAVY_WAIT_TIMEOUT=1 cmd_pre)
assert_eq "$(printf '%s' "$TIMEOUT_OUT" | jq -r '.hookSpecificOutput.permissionDecision')" "allow" "a timed-out wait still allows the command"
assert_eq "$(printf '%s' "$TIMEOUT_OUT" | jq -r '.hookSpecificOutput.updatedInput.command')" "$HEAVY_SELF hold 'task generate'" "a timed-out wait still runs the command through hold"
assert_eq "$(ls -1 "$(queue_dir)" | wc -l | tr -d ' ')" "1" "a timed-out wait drops its own ticket"
rm -f "$(queue_dir)"/*.json

# A state dir it cannot write is not a reason to block a session or to leak raw
# redirect errors onto hook stderr. pre gives up its place in line at once and
# hold runs the command without a lock it cannot open.
RO_BASE=$(mktemp -d)
chmod 500 "$RO_BASE"
RO_OUT=$(mktemp)
RO_ERR=$(printf '%s' '{"session_id":"s9","tool_use_id":"tu_ro","cwd":"/tmp","tool_name":"Bash","tool_input":{"command":"task generate"}}' \
  | HEAVY_STATE_DIR="$RO_BASE/yimbot" timeout 20 bash "$(dirname "$0")/heavy-queue.sh" pre 2>&1 > "$RO_OUT")
assert_eq "$RO_ERR" "" "an unwritable state dir leaks nothing to hook stderr"
assert_eq "$(jq -r '.hookSpecificOutput.updatedInput.command' < "$RO_OUT")" "$HEAVY_SELF hold 'task generate'" "an unwritable state dir still runs the command through hold"
RO_ERR=$(HEAVY_STATE_DIR="$RO_BASE/yimbot" timeout 20 bash "$(dirname "$0")/heavy-queue.sh" hold 'echo ran-it' 2>&1 > "$RO_OUT")
assert_eq "$RO_ERR" "" "a lock it cannot open leaks nothing to stderr"
assert_eq "$(cat "$RO_OUT")" "ran-it" "a lock it cannot open still runs the command"
chmod 700 "$RO_BASE"
rm -rf "$RO_BASE" "$RO_OUT"

# A malformed payload is not a reason to block a session.
assert_eq "$(printf 'not json' | cmd_pre; echo "rc=$?")" "rc=0" "a malformed payload yields no decision and no error"

# --- session settings wiring ---
SETTINGS_JSON="$(cd "$(dirname "$0")" && pwd)/../settings/session-settings.json"
assert_eq "$(node -e 'const h=require(process.argv[1]).hooks||{}; process.stdout.write(String(!!h.PreToolUse&&!!h.PostToolUse))' "$SETTINGS_JSON")" "true" "settings define both queue hooks"
PRE_HOOK=$(node -e 'const e=require(process.argv[1]).hooks.PreToolUse[0]; process.stdout.write(e.matcher+"|"+e.hooks[0].command+"|"+e.hooks[0].timeout)' "$SETTINGS_JSON")
assert_eq "$(printf '%s' "$PRE_HOOK" | cut -d'|' -f1)" "Bash" "the queue hook only matches Bash"
# The command quotes the path, so the closing quote sits right before " pre".
assert_eq "$(printf '%s' "$PRE_HOOK" | grep -c 'heavy-queue.sh" pre')" "1" "PreToolUse runs the pre subcommand"
# The hook must be allowed to outlast HEAVY_WAIT_TIMEOUT, or Claude Code kills
# the wait before the queue ever gets to hand over the slot.
assert_ok test "$(printf '%s' "$PRE_HOOK" | cut -d'|' -f3)" -gt "$HEAVY_WAIT_TIMEOUT"
assert_eq "$(node -e 'process.stdout.write(require(process.argv[1]).hooks.PostToolUse[0].hooks[0].command)' "$SETTINGS_JSON" | grep -c 'heavy-queue.sh" post')" "1" "PostToolUse runs the post subcommand"

# --- status ---
assert_defined cmd_status
rm -f "$(queue_dir)"/*.json
assert_eq "$(cmd_status --json | jq -c '.')" '{"running":null,"waiting":[]}' "an empty queue reports nothing running"
assert_eq "$(cmd_status)" "" "an idle queue prints nothing on the human table"
assert_eq "$(cmd_status >/dev/null 2>&1; echo $?)" "0" "an idle queue exits cleanly on the human table"

R=$(ticket_path); ticket_write "$R" "ENG-1" "task generate" running
sleep 0.01
W=$(ticket_path); ticket_write "$W" "ENG-2" "pnpm build" waiting
assert_eq "$(cmd_status --json | jq -r '.running.key')" "ENG-1" "the head ticket is reported as running"
assert_eq "$(cmd_status --json | jq -r '.waiting[0].key')" "ENG-2" "the rest are reported as waiting"
assert_eq "$(cmd_status --json | jq -r '.waiting | length')" "1" "only the non-head tickets wait"
assert_eq "$(cmd_status | grep -c 'ENG-1')" "1" "the human table names the holder"

# The human table reports how long each entry has held or waited for the slot.
printf '{"key":"ENG-1","cmd":"task generate","state":"running","since":%s}\n' "$(( $(date +%s%N) / 1000000 - 90000 ))" > "$R"
assert_eq "$(cmd_status | head -1 | cut -f2)" "1m" "the human table shows how long the holder has held the slot"
printf '{"key":"ENG-1","cmd":"task generate","state":"running","since":%s}\n' "$(( $(date +%s%N) / 1000000 - 5000 ))" > "$R"
assert_eq "$(cmd_status | head -1 | cut -f2)" "5s" "a short hold reports in seconds"
rm -f "$(queue_dir)"/*.json

if [ "$fail" -eq 0 ]; then echo "PASS: heavy-queue.sh tests"; else exit 1; fi
