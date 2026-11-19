#!/bin/bash
# Unit tests for wait-local-env.sh. Sourcing must load the functions WITHOUT
# running main (source-guard).
set -u
source "$(dirname "$0")/wait-local-env.sh"

fail=0
assert_eq() { # got want label
  if [ "$1" != "$2" ]; then echo "FAIL: $3 - got [$1] want [$2]"; fail=1; fi
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

printf 'APP_PORT=8017\nREACT_UI_PORT=3017\n' > "$TMP/plain.env"
assert_eq "$(read_env_port "$TMP/plain.env" APP_PORT)" "8017" "reads APP_PORT"
assert_eq "$(read_env_port "$TMP/plain.env" REACT_UI_PORT)" "3017" "reads REACT_UI_PORT"

printf 'REACT_UI_PORT="3017"\n' > "$TMP/quoted.env"
assert_eq "$(read_env_port "$TMP/quoted.env" REACT_UI_PORT)" "3017" "strips quotes"

printf 'REACT_UI_PORT= 3017 \n' > "$TMP/spaced.env"
assert_eq "$(read_env_port "$TMP/spaced.env" REACT_UI_PORT)" "3017" "strips spaces"

assert_eq "$(read_env_port "$TMP/plain.env" LANGSERVE_PORT)" "" "missing key is empty"

# main calls exit, so each run is wrapped in a subshell and its status captured.
mkdir -p "$TMP/no-env" "$TMP/no-react" "$TMP/wt"
assert_eq "$( (main "$TMP/no-env" 1) >/dev/null 2>&1; echo $?)" "1" "no .env.worktree exits 1"

printf 'APP_PORT=8017\n' > "$TMP/no-react/.env.worktree"
assert_eq "$( (main "$TMP/no-react" 1) >/dev/null 2>&1; echo $?)" "1" "missing REACT_UI_PORT exits 1"

cp "$TMP/plain.env" "$TMP/wt/.env.worktree"
assert_eq "$( (port_listening() { return 0; }; main "$TMP/wt" 1) 2>/dev/null)" "http://localhost:3017" "prints React URL when both ports listen"
assert_eq "$( (port_listening() { return 0; }; main "$TMP/wt" 1) >/dev/null 2>&1; echo $?)" "0" "exits 0 when both ports listen"

assert_eq "$( (port_listening() { [ "$1" = 8017 ]; }; WAIT_LOCAL_ENV_INTERVAL=0 main "$TMP/wt" 1) >/dev/null 2>&1; echo $?)" "2" "times out with only one port up"

if [ "$fail" -eq 0 ]; then echo "PASS: wait-local-env.sh helper tests"; fi
exit "$fail"
