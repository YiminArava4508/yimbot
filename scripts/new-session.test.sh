#!/bin/bash
# Unit tests for the sourceable helpers in new-session.sh. Sourcing must load the
# functions WITHOUT running session setup (source-guard).
set -u
source "$(dirname "$0")/new-session.sh"

fail=0
assert_eq() { if [ "$1" != "$2" ]; then echo "FAIL: $3 - got [$1] want [$2]"; fail=1; fi; }
assert_defined() { if ! declare -F "$1" >/dev/null; then echo "FAIL: $1 not defined after sourcing"; fail=1; fi; }

# The helpers split-pr.sh reuses must survive sourcing.
assert_defined seed_prompt_for
assert_defined create_worktree
assert_defined launch_claude_in

# A deny-list settings file, when present, is passed to claude via --settings.
SETTINGS_TMP=$(mktemp)
assert_eq "$(SESSION_SETTINGS=$SETTINGS_TMP build_claude_cmd | grep -c -- "--settings $SETTINGS_TMP")" "1" "passes --settings when the file exists"
rm -f "$SETTINGS_TMP"
assert_eq "$(SESSION_SETTINGS=/no/such/settings.json build_claude_cmd | grep -c -- '--settings')" "0" "omits --settings when the file is absent"

# seed_prompt_for still classifies recognized session names.
assert_eq "$(seed_prompt_for eng-42-add-widget | grep -c 'pickup-ticket skill')" "1" "eng seed hands off to pickup-ticket"
assert_eq "$(seed_prompt_for sc-7-foo | grep -c 'pickup-ticket skill')" "1" "sc seed hands off to pickup-ticket"
assert_eq "$(seed_prompt_for pr-9-fix | grep -c 'address-pr-comments skill')" "1" "pr-fix seed hands off to address-pr-comments"
assert_eq "$(seed_prompt_for pr-9-ci | grep -c 'fix-pr-ci skill')" "1" "pr-ci seed hands off to fix-pr-ci"
assert_eq "$(seed_prompt_for pr-9-ci | grep -c '#9')" "1" "pr-ci seed names the PR number"
assert_eq "$(seed_prompt_for random-name)" "" "unrecognized name yields no seed"

if [ "$fail" -eq 0 ]; then echo "PASS: new-session.sh helper tests"; else exit 1; fi
