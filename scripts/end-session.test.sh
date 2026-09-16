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

# Teardown step order. Headless (the daemon) kills the tmux session FIRST so a
# dev server (or anything) writing into the worktree stops before removal - else
# it races rm -rf and wedges the whole teardown. Interactive keeps the session
# LAST: the script runs inside that session, so killing it first would abort.
assert_eq "$(teardown_steps true)" "kill_session remove_worktree delete_branch" "headless kills session first"
assert_eq "$(teardown_steps false)" "remove_worktree delete_branch kill_session" "interactive kills session last"

# worktree_path_for_branch resolves the dir git checked a branch out into from
# porcelain output, even when the dir name diverges from the branch (the
# mismatch that looped cleanup forever). Pure: parses its input, no git call.
PORCELAIN=$'worktree /wt/fix-dealteam-integration-tx\nHEAD abc\nbranch refs/heads/fix/wrike-add-shared-users-integration-tx\n\nworktree /wt/eng-42\nHEAD def\nbranch refs/heads/eng-42\n'
assert_eq "$(worktree_path_for_branch "$PORCELAIN" "fix/wrike-add-shared-users-integration-tx")" "/wt/fix-dealteam-integration-tx" "resolves diverged dir by branch"
assert_eq "$(worktree_path_for_branch "$PORCELAIN" "eng-42")" "/wt/eng-42" "resolves matching dir by branch"
assert_eq "$(worktree_path_for_branch "$PORCELAIN" "no/such-branch")" "" "empty when branch absent"

if [ "$fail" -eq 0 ]; then echo "PASS: end-session.sh helper tests"; else exit 1; fi
