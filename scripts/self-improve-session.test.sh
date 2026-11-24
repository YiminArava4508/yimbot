#!/bin/bash
# Unit tests for the sourceable helpers in self-improve-session.sh. Sourcing must
# load the functions WITHOUT creating a session (source-guard).
set -u
source "$(dirname "$0")/self-improve-session.sh"

fail=0
assert_eq() { if [ "$1" != "$2" ]; then echo "FAIL: $3 - got [$1] want [$2]"; fail=1; fi; }
assert_defined() { if ! declare -F "$1" >/dev/null; then echo "FAIL: $1 not defined after sourcing"; fail=1; fi; }

assert_defined self_improve_session_name
assert_defined self_improve_branch
assert_defined self_improve_seed_prompt
assert_defined self_improve_args_safe

assert_eq "$(self_improve_session_name dead-code-scan)" "self-improve-dead-code-scan" "session name prefixes the job id"
assert_eq "$(self_improve_branch dead-code-scan 2026-11-24)" "chore/self-improve-dead-code-scan-2026-11-24" "branch carries job id and date"

SEED=$(self_improve_seed_prompt dead-code-scan dead-code-scan)
assert_eq "$(printf '%s' "$SEED" | grep -c 'dead-code-scan skill')" "1" "seed invokes the job skill"
assert_eq "$(printf '%s' "$SEED" | grep -c 'self-improve-contract')" "1" "seed names the contract skill"

self_improve_args_safe dead-code-scan chore/self-improve-dead-code-scan-2026-11-24
assert_eq "$?" "0" "args_safe allows a job id and branch"
self_improve_args_safe 'Bad_Id' chore/x
assert_eq "$?" "1" "args_safe rejects uppercase and underscore in the job id"
self_improve_args_safe 'a b' chore/x
assert_eq "$?" "1" "args_safe rejects a space in the job id"
self_improve_args_safe dead-code-scan 'chore/x"y'
assert_eq "$?" "1" "args_safe rejects a quote in the branch"
self_improve_args_safe dead-code-scan 'chore/$(x)'
assert_eq "$?" "1" "args_safe rejects shell metacharacters in the branch"
self_improve_args_safe dead-code-scan 'refs/heads/x'
assert_eq "$?" "1" "args_safe requires the chore/self-improve- branch prefix"

[ "$fail" -eq 0 ] && echo "self-improve-session tests passed"
exit "$fail"
