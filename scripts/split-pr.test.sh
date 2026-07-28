#!/bin/bash
# Unit tests for the pure helpers + arg validation in split-pr.sh. Sourcing loads
# the helpers WITHOUT running setup (source-guard) and WITHOUT sourcing new-session.sh.
set -u
source "$(dirname "$0")/split-pr.sh"

fail=0
assert_eq() { if [ "$1" != "$2" ]; then echo "FAIL: $3 - got [$1] want [$2]"; fail=1; fi; }

assert_eq "$(pr_window_name 1 3)" "PR (1/3)" "window name 1 of 3"
assert_eq "$(pr_window_name 2 2)" "PR (2/2)" "window name 2 of 2"
assert_eq "$(resolve_target_session my-session)" "my-session" "explicit session passthrough"
assert_eq "$(parent_marker_path /home/ymbo/Work/worktrees/eng-1)" "/home/ymbo/Work/worktrees/eng-1/.yimbot-parent-session" "marker path"

# Missing required args must exit non-zero with a usage message.
out=$(bash "$(dirname "$0")/split-pr.sh" 2>&1); rc=$?
assert_eq "$rc" "1" "no-args exits 1"
assert_eq "$(printf '%s' "$out" | grep -c 'Usage:')" "1" "no-args prints usage"

if [ "$fail" -eq 0 ]; then echo "PASS: split-pr.sh helper tests"; else exit 1; fi
