#!/bin/bash
# Unit tests for scripts/no-self-rebase.sh. Sourcing loads the helpers WITHOUT
# running the hook (source-guard).
set -u
source "$(dirname "$0")/no-self-rebase.sh"

fail=0
assert_eq() { if [ "$1" != "$2" ]; then echo "FAIL: $3 - got [$1] want [$2]"; fail=1; fi; }
assert_defined() { if ! declare -F "$1" >/dev/null; then echo "FAIL: $1 not defined after sourcing"; fail=1; fi; }
assert_ok() { if ! "$@"; then echo "FAIL: expected denied: $*"; fail=1; fi; }
assert_fails() { if "$@"; then echo "FAIL: expected allowed: $*"; fail=1; fi; }

assert_defined is_self_rebase
assert_defined cmd_pre

B=eng-1-thing

# pull --rebase in any spelling rebases the branch onto its own remote.
assert_ok is_self_rebase 'git pull --rebase origin eng-1-thing' "$B"
assert_ok is_self_rebase 'git pull --rebase origin "$(git branch --show-current)" && git push' "$B"
assert_ok is_self_rebase 'git pull origin eng-1-thing --rebase' "$B"
assert_ok is_self_rebase 'git pull -r origin eng-1-thing' "$B"
assert_ok is_self_rebase 'git pull -qr' "$B"
assert_ok is_self_rebase 'git pull --rebase=merges' "$B"
assert_ok is_self_rebase 'cd /home/x/wt && git fetch && git pull --rebase' "$B"

# Explicitly merging pulls are fine.
assert_fails is_self_rebase 'git pull --no-rebase --no-edit origin eng-1-thing && git push' "$B"
assert_fails is_self_rebase 'git pull --rebase=false origin eng-1-thing' "$B"
assert_fails is_self_rebase 'git pull --ff-only origin eng-1-thing' "$B"
assert_fails is_self_rebase 'git pull origin main' "$B"

# rebase onto the branch's own remote is the same footgun spelled out.
assert_ok is_self_rebase 'git rebase origin/eng-1-thing' "$B"
assert_ok is_self_rebase 'git rebase -i origin/eng-1-thing' "$B"
assert_ok is_self_rebase 'git rebase @{u}' "$B"
assert_ok is_self_rebase 'git rebase @{upstream}' "$B"
assert_ok is_self_rebase 'git rebase --onto origin/eng-1-thing abc123' "$B"

# Rebasing elsewhere, or housekeeping, stays allowed.
assert_fails is_self_rebase 'git rebase --onto main sibling-branch' "$B"
assert_fails is_self_rebase 'git rebase origin/main' "$B"
assert_fails is_self_rebase 'git rebase --abort' "$B"
assert_fails is_self_rebase 'git rebase --continue' "$B"
assert_fails is_self_rebase 'atlas migrate rebase --dir file://migrations 2024.sql' "$B"
assert_fails is_self_rebase 'task atlas-auto-rebase' "$B"
assert_fails is_self_rebase 'git log --oneline origin/eng-1-thing' "$B"

# Unknown branch: only the pull form can be judged.
assert_fails is_self_rebase 'git rebase origin/eng-1-thing' ""
assert_ok is_self_rebase 'git pull --rebase' ""

# End to end: the hook denies with a reason naming the merge alternative, and
# lets an unrelated command through silently.
REPO=$(mktemp -d)
git -C "$REPO" init -q -b eng-1-thing
payload() { jq -nc --arg c "$1" --arg d "$REPO" '{tool_name:"Bash",tool_input:{command:$c},cwd:$d}'; }
out=$(payload 'git pull --rebase origin eng-1-thing' | bash "$(dirname "$0")/no-self-rebase.sh" pre)
assert_eq "$(printf '%s' "$out" | jq -r .hookSpecificOutput.permissionDecision)" "deny" "denies pull --rebase"
assert_eq "$(printf '%s' "$out" | jq -r .hookSpecificOutput.permissionDecisionReason | grep -c 'git pull --no-rebase --no-edit origin eng-1-thing')" "1" "reason names the merge alternative"
out=$(payload 'git rebase origin/eng-1-thing' | bash "$(dirname "$0")/no-self-rebase.sh" pre)
assert_eq "$(printf '%s' "$out" | jq -r .hookSpecificOutput.permissionDecision)" "deny" "denies rebase onto own remote"
out=$(payload 'git status' | bash "$(dirname "$0")/no-self-rebase.sh" pre)
assert_eq "$out" "" "unrelated command passes silently"
# A bare pull under pull.rebase=true is a rebase too.
git -C "$REPO" config pull.rebase true
out=$(payload 'git pull origin eng-1-thing' | bash "$(dirname "$0")/no-self-rebase.sh" pre)
assert_eq "$(printf '%s' "$out" | jq -r .hookSpecificOutput.permissionDecision)" "deny" "denies bare pull when pull.rebase is on"
git -C "$REPO" config pull.rebase false
out=$(payload 'git pull origin eng-1-thing' | bash "$(dirname "$0")/no-self-rebase.sh" pre)
assert_eq "$out" "" "bare pull passes when pull.rebase is off"
# Garbage stdin exits 0 and lets the call through.
out=$(printf 'not json' | bash "$(dirname "$0")/no-self-rebase.sh" pre)
assert_eq "$out" "" "garbage payload passes"
rm -rf "$REPO"

# The session settings wire the hook as a PreToolUse Bash hook and deny the
# prefix forms outright.
SETTINGS_JSON="$(cd "$(dirname "$0")" && pwd)/../settings/session-settings.json"
assert_eq "$(node -e 'const p=require(process.argv[1]); const h=p.hooks.PreToolUse.filter(e=>e.matcher==="Bash"&&e.hooks[0].command.includes("no-self-rebase.sh\" pre")); process.stdout.write(String(h.length))' "$SETTINGS_JSON")" "1" "settings run the hook on Bash"
assert_eq "$(node -e 'const p=require(process.argv[1]); process.stdout.write(String(p.permissions.deny.includes("Bash(git pull --rebase:*)")))' "$SETTINGS_JSON")" "true" "deny-list blocks the prefix form"

[ $fail -eq 0 ] && echo "PASS no-self-rebase.test.sh"
exit $fail
