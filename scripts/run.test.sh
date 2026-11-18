#!/bin/bash
# Unit tests for scripts/run.sh. Sourcing loads the helpers WITHOUT running the
# relaunch loop (source-guard). Uses a throwaway origin + clone.
set -u
source "$(dirname "$0")/run.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

fail=0
assert_eq() { if [ "$1" != "$2" ]; then echo "FAIL: $3 - got [$1] want [$2]"; fail=1; fi; }
assert_defined() { if ! declare -F "$1" >/dev/null; then echo "FAIL: $1 not defined after sourcing"; fail=1; fi; }
assert_ok() { if ! "$@"; then echo "FAIL: expected success: $*"; fail=1; fi; }
assert_fails() { if "$@"; then echo "FAIL: expected failure: $*"; fail=1; fi; }

assert_defined crashed_on_boot
assert_defined can_roll_back
assert_defined roll_back

assert_ok crashed_on_boot 1 5
assert_fails crashed_on_boot 75 5
assert_fails crashed_on_boot 0 5
assert_fails crashed_on_boot 1 45

git init -q --bare -b master "$tmp/origin.git"
git clone -q "$tmp/origin.git" "$tmp/clone" 2>/dev/null
cd "$tmp/clone"
git checkout -q -b master 2>/dev/null
echo a > f.txt; git add f.txt; git commit -qm one
echo a > pnpm-lock.yaml; git add pnpm-lock.yaml; git commit -qm lock
base=$(git rev-parse HEAD)
echo b > f.txt; git commit -qam two
pushed=$(git rev-parse HEAD)
git push -q origin master 2>/dev/null
git fetch -q origin

assert_ok can_roll_back "$base" "$pushed"
assert_fails can_roll_back "$pushed" "$base"
assert_fails can_roll_back "" "$pushed"

echo c > f.txt; git commit -qam local-only
local_sha=$(git rev-parse HEAD)
assert_fails can_roll_back "$pushed" "$local_sha"

git reset -q --hard "$pushed"
echo dirty > f.txt
assert_fails can_roll_back "$base" "$pushed"
git checkout -q f.txt

echo keep > untracked.txt
assert_ok can_roll_back "$base" "$pushed"
roll_back "$base" "$pushed" >/dev/null 2>&1
assert_eq "$(git rev-parse HEAD)" "$base" "roll_back moves HEAD to prev"
assert_eq "$(cat untracked.txt)" "keep" "roll_back leaves untracked files"

exit $fail
