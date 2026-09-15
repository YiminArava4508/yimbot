#!/bin/bash
# Unit tests for the sourceable helpers in qa-session.sh. Sourcing must load
# the functions WITHOUT creating a session (source-guard).
set -u
source "$(dirname "$0")/qa-session.sh"

fail=0
assert_eq() { if [ "$1" != "$2" ]; then echo "FAIL: $3 - got [$1] want [$2]"; fail=1; fi; }
assert_defined() { if ! declare -F "$1" >/dev/null; then echo "FAIL: $1 not defined after sourcing"; fail=1; fi; }

assert_defined qa_seed_prompt
assert_defined qa_session_name
assert_defined qa_args_safe

assert_eq "$(qa_session_name ENG-90)" "eng-90-qa" "session name lowercases and appends -qa"

qa_args_safe ENG-90 https://np.example "ENG-1,ENG-2" "acme/app#1,#2"
assert_eq "$?" "0" "qa_args_safe allows plain arguments"
qa_args_safe 'a"b'
assert_eq "$?" "1" "qa_args_safe rejects a double quote"
qa_args_safe 'a$b'
assert_eq "$?" "1" "qa_args_safe rejects a dollar sign"
qa_args_safe 'a`b'
assert_eq "$?" "1" "qa_args_safe rejects a backtick"
qa_args_safe 'a\b'
assert_eq "$?" "1" "qa_args_safe rejects a backslash"

SEED=$(qa_seed_prompt ENG-90 https://np.example "ENG-101,ENG-102" "acme/app#12,#7")
assert_eq "$(printf '%s' "$SEED" | grep -c 'qa-instructions skill')" "1" "seed hands off to qa-instructions"
assert_eq "$(printf '%s' "$SEED" | grep -c 'get-ticket.sh ENG-90')" "1" "seed reads the parent through the API script"
assert_eq "$(printf '%s' "$SEED" | grep -c 'ENG-101, ENG-102')" "1" "seed lists the children"
assert_eq "$(printf '%s' "$SEED" | grep -c 'acme/app#12, #7')" "1" "seed lists the PRs"
assert_eq "$(printf '%s' "$SEED" | grep -c 'https://np.example')" "1" "seed carries the nonprod url"

if [ $fail -eq 0 ]; then echo "qa-session.test.sh: all passed"; fi
exit $fail
