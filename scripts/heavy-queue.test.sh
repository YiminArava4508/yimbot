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

heavy_conf_load

# The shipped conf supplies every tunable.
assert_eq "$HEAVY_WAIT_TIMEOUT" "1200" "wait timeout from conf"
assert_eq "$HEAVY_MAX_JOB" "1800" "max job from conf"
assert_eq "$HEAVY_STALE_WAIT" "5" "stale wait default"

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
assert_eq "$(printf '%s' "$PRE_OUT" | jq -r '.hookSpecificOutput.updatedInput.command')" "$HEAVY_SELF hold 'task generate'" "the command is rewritten through hold"
assert_eq "$(ls -1 "$(queue_dir)" | wc -l | tr -d ' ')" "1" "a heavy command leaves a running ticket"
assert_eq "$(ticket_field "$(ticket_head)" state)" "running" "the head ticket is marked running"

# Quoting is what breaks a command rewrite, so test the quoter directly.
assert_defined shell_quote
assert_eq "$(eval "printf '%s' $(shell_quote "it's fine")")" "it's fine" "shell_quote survives a single quote"
DQ_INPUT='a "b" c'
assert_eq "$(eval "printf '%s' $(shell_quote "$DQ_INPUT")")" "$DQ_INPUT" "shell_quote survives double quotes"
assert_eq "$(eval "printf '%s' $(shell_quote 'a $(rm -rf /) b')")" 'a $(rm -rf /) b' "shell_quote defuses command substitution"

# post removes only this session's ticket.
rm -f "$(queue_dir)"/*.json
printf '%s' '{"session_id":"s4","cwd":"/tmp","tool_name":"Bash","tool_input":{"command":"task generate"}}' | cmd_pre > /dev/null
OTHER=$(ticket_path); ticket_write "$OTHER" "ENG-9" "pnpm build" waiting
printf '%s' '{"session_id":"s4","cwd":"/tmp","tool_name":"Bash","tool_input":{"command":"task generate"}}' | cmd_post
assert_eq "$(ls -1 "$(queue_dir)" | wc -l | tr -d ' ')" "1" "post drops one ticket"
assert_eq "$(ticket_field "$(ticket_head)" key)" "ENG-9" "post left the other session's ticket alone"
rm -f "$(queue_dir)"/*.json

# Waiting behind a live ticket times out rather than hanging forever, and the
# timeout path still lets the command run.
BLOCKER=$(ticket_path); ticket_write "$BLOCKER" "ENG-8" "task build-all" running
MINE=$(ticket_path); ticket_write "$MINE" "ENG-7" "task generate" waiting
assert_fails env HEAVY_WAIT_TIMEOUT=1 bash -c "source '$(dirname "$0")/heavy-queue.sh'; heavy_conf_load; HEAVY_WAIT_TIMEOUT=1; wait_for_head '$MINE'"
rm -f "$(queue_dir)"/*.json

# A malformed payload is not a reason to block a session.
assert_eq "$(printf 'not json' | cmd_pre; echo "rc=$?")" "rc=0" "a malformed payload yields no decision and no error"

# --- session settings wiring ---
SETTINGS_JSON="$(cd "$(dirname "$0")" && pwd)/../settings/session-settings.json"
assert_eq "$(node -e 'const h=require(process.argv[1]).hooks||{}; process.stdout.write(String(!!h.PreToolUse&&!!h.PostToolUse))' "$SETTINGS_JSON")" "true" "settings define both queue hooks"
PRE_HOOK=$(node -e 'const e=require(process.argv[1]).hooks.PreToolUse[0]; process.stdout.write(e.matcher+"|"+e.hooks[0].command+"|"+e.hooks[0].timeout)' "$SETTINGS_JSON")
assert_eq "$(printf '%s' "$PRE_HOOK" | cut -d'|' -f1)" "Bash" "the queue hook only matches Bash"
# The closing quote around the path sits right before " pre", so allow one
# extra character there instead of requiring "sh pre" contiguous.
assert_eq "$(printf '%s' "$PRE_HOOK" | grep -c 'heavy-queue.sh. pre')" "1" "PreToolUse runs the pre subcommand"
# The hook must be allowed to outlast HEAVY_WAIT_TIMEOUT, or Claude Code kills
# the wait before the queue ever gets to hand over the slot.
assert_ok test "$(printf '%s' "$PRE_HOOK" | cut -d'|' -f3)" -gt "$HEAVY_WAIT_TIMEOUT"
assert_eq "$(node -e 'process.stdout.write(require(process.argv[1]).hooks.PostToolUse[0].hooks[0].command)' "$SETTINGS_JSON" | grep -c 'heavy-queue.sh. post')" "1" "PostToolUse runs the post subcommand"

if [ "$fail" -eq 0 ]; then echo "PASS: heavy-queue.sh tests"; else exit 1; fi
