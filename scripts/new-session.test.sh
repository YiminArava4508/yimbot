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
assert_defined build_claude_cmd
assert_defined default_branch_of

# default_branch_of: the DEFAULT_BRANCH override wins without reading git, and
# an unreadable repo falls back to main.
assert_eq "$(DEFAULT_BRANCH=develop default_branch_of /no/such/repo)" "develop" "DEFAULT_BRANCH override wins"
assert_eq "$(unset DEFAULT_BRANCH; default_branch_of /no/such/repo)" "main" "falls back to main when git can't resolve"

# Sessions launch in auto mode: the classifier auto-approves safe actions and no
# bypass-mode confirmation screen blocks the unattended start.
assert_eq "$(build_claude_cmd | grep -c -- '--permission-mode auto')" "1" "runs in auto mode"
assert_eq "$(build_claude_cmd | grep -c -- '--dangerously-skip-permissions')" "0" "does not bypass permissions"
assert_eq "$(PLAN_MODEL=opus build_claude_cmd | grep -c -- '--model opus')" "1" "honors PLAN_MODEL"
assert_eq "$(IMPL_MODEL=sonnet build_claude_cmd | grep -c 'IMPL_MODEL=sonnet')" "1" "passes IMPL_MODEL through"

# A deny-list settings file, when present, is passed to claude via --settings.
SETTINGS_TMP=$(mktemp)
assert_eq "$(SESSION_SETTINGS=$SETTINGS_TMP build_claude_cmd | grep -c -- "--settings $SETTINGS_TMP")" "1" "passes --settings when the file exists"
rm -f "$SETTINGS_TMP"
assert_eq "$(SESSION_SETTINGS=/no/such/settings.json build_claude_cmd | grep -c -- '--settings')" "0" "omits --settings when the file is absent"

# seed_prompt_for still classifies recognized session names.
assert_eq "$(seed_prompt_for eng-42-add-widget | grep -c 'pickup-ticket skill')" "1" "eng seed hands off to pickup-ticket"
assert_eq "$(seed_prompt_for eng-949-cont-2 | grep -c 'acceptance-criteria tracker')" "1" "eng-cont seed is AC-scoped, not the generic eng seed"
assert_eq "$(seed_prompt_for eng-949-cont-2 | grep -c 'ENG-949')" "1" "eng-cont seed names the issue"
assert_eq "$(seed_prompt_for sc-7-foo | grep -c 'pickup-ticket skill')" "1" "sc seed hands off to pickup-ticket"
assert_eq "$(seed_prompt_for pr-9-fix | grep -c 'address-pr-comments skill')" "1" "pr-fix seed hands off to address-pr-comments"
assert_eq "$(seed_prompt_for pr-9-ci | grep -c 'fix-pr-ci skill')" "1" "pr-ci seed hands off to fix-pr-ci"
assert_eq "$(seed_prompt_for pr-9-ci | grep -c '#9')" "1" "pr-ci seed names the PR number"
assert_eq "$(seed_prompt_for pr-9-conflict | grep -c 'fix-pr-conflict skill')" "1" "pr-conflict seed hands off to fix-pr-conflict"
assert_eq "$(seed_prompt_for pr-9-conflict | grep -c '#9')" "1" "pr-conflict seed names the PR number"
assert_eq "$(seed_prompt_for pr-9-blocked | grep -c 'fix-pr-blocked skill')" "1" "pr-blocked seed hands off to fix-pr-blocked"
assert_eq "$(seed_prompt_for pr-9-blocked | grep -c '#9')" "1" "pr-blocked seed names the PR number"
assert_eq "$(skill_in_prompt "$(seed_prompt_for pr-9-blocked)")" "fix-pr-blocked" "extracts fix-pr-blocked"
assert_eq "$(seed_prompt_for random-name)" "" "unrecognized name yields no seed"

# Preflight helpers survive sourcing.
assert_defined skill_in_prompt
assert_defined verify_seed_skill

# skill_in_prompt extracts the handed-off skill from each recognized seed prompt.
assert_eq "$(skill_in_prompt "$(seed_prompt_for pr-9-ci)")" "fix-pr-ci" "extracts fix-pr-ci"
assert_eq "$(skill_in_prompt "$(seed_prompt_for pr-9-conflict)")" "fix-pr-conflict" "extracts fix-pr-conflict"
assert_eq "$(skill_in_prompt "$(seed_prompt_for pr-9-fix)")" "address-pr-comments" "extracts address-pr-comments"
assert_eq "$(skill_in_prompt "$(seed_prompt_for sc-7-foo)")" "pickup-ticket" "extracts pickup-ticket"
assert_eq "$(skill_in_prompt "$(seed_prompt_for random-name)")" "" "no skill in a bare prompt"

# verify_seed_skill passes when the named skill is installed under SKILLS_DIR.
SK_TMP=$(mktemp -d)
mkdir -p "$SK_TMP/fix-pr-ci"; : > "$SK_TMP/fix-pr-ci/SKILL.md"
assert_eq "$(SKILLS_DIR=$SK_TMP verify_seed_skill pr-9-ci >/dev/null 2>&1; echo $?)" "0" "passes when skill present"

# verify_seed_skill dies (non-zero) when the named skill is absent. die() calls
# exit, which would terminate this test script if run inline; wrap the call in
# a subshell so only that subshell exits, and capture its status via $?.
SK_EMPTY=$(mktemp -d)
( SKILLS_DIR=$SK_EMPTY verify_seed_skill pr-9-ci >/dev/null 2>&1 )
assert_eq "$?" "1" "dies when skill missing"

# A bare/unrecognized name is a no-op regardless of SKILLS_DIR.
assert_eq "$(SKILLS_DIR=$SK_EMPTY verify_seed_skill random-name >/dev/null 2>&1; echo $?)" "0" "no-op for bare name"
rm -rf "$SK_TMP" "$SK_EMPTY"

if [ "$fail" -eq 0 ]; then echo "PASS: new-session.sh helper tests"; else exit 1; fi
