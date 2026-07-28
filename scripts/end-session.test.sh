#!/bin/bash
# Unit tests for the pure helpers in end-session.sh. Sourcing must load the
# functions WITHOUT running teardown (source-guard).
set -u
source "$(dirname "$0")/end-session.sh"

fail=0
assert_eq() { # got want label
  if [ "$1" != "$2" ]; then echo "FAIL: $3 - got [$1] want [$2]"; fail=1; fi
}

# sanitize_worktree_dir must match new-session.sh's rule so a session name maps
# to the same worktree dir the launcher created.
assert_eq "$(sanitize_worktree_dir "eng-42-add-widget")" "eng-42-add-widget" "clean slug unchanged"
assert_eq "$(sanitize_worktree_dir "feature/foo bar")" "feature-foo-bar" "disallowed chars replaced"
assert_eq "$(sanitize_worktree_dir "$(printf 'a%.0s' {1..60})")" "$(printf 'a%.0s' {1..50})" "capped at 50"

# Headless callers force-delete the branch (-D); interactive keeps the safe -d.
assert_eq "$(branch_delete_flag true)" "-D" "headless force delete"
assert_eq "$(branch_delete_flag false)" "-d" "interactive safe delete"

# CODEBASE_PATH defaults to the daemon's ~/Work/gemini when unset (an interactive
# teardown has no env var), and honors an explicit override.
assert_eq "$(CODEBASE_PATH=/tmp/repo codebase_path)" "/tmp/repo" "honors CODEBASE_PATH override"
assert_eq "$(unset CODEBASE_PATH; codebase_path)" "$HOME/Work/gemini" "defaults to ~/Work/gemini when unset"

if [ "$fail" -eq 0 ]; then echo "PASS: end-session.sh helper tests"; else exit 1; fi
