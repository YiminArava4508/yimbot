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

if [ "$fail" -eq 0 ]; then echo "PASS: heavy-queue.sh tests"; else exit 1; fi
