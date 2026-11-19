#!/bin/bash
# Tests for needs-decision.sh: raises needs_decision + a decision flag for the
# current worktree's ticket, and survives free-text reasons.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
fail=0
assert_eq() { if [ "$1" != "$2" ]; then echo "FAIL: $3 - got [$1] want [$2]"; fail=1; fi; }

REPO=$(mktemp -d)
git -C "$REPO" init -q -b eng-7-demo
git -C "$REPO" commit -q --allow-empty -m init
LOG=$(mktemp)

( cd "$REPO" && EVENTS_LOG="$LOG" bash "$HERE/needs-decision.sh" "check 4 failed: last_called_at 3h ago" )
assert_eq "$?" "0" "exits 0"
assert_eq "$(grep -c '"kind":"needs_decision"' "$LOG")" "1" "writes one needs_decision"
assert_eq "$(grep '"kind":"needs_decision"' "$LOG" | grep -c '"key":"ENG-7"')" "1" "keyed by the ticket"
assert_eq "$(grep '"kind":"needs_decision"' "$LOG" | grep -c 'last_called_at 3h ago')" "1" "carries the reason"
assert_eq "$(grep -c '"kind":"flagged".*"reason":"decision"' "$LOG")" "1" "raises the decision flag"

# Quotes, backslashes and newlines in the reason must not break the JSONL.
LOG2=$(mktemp)
( cd "$REPO" && EVENTS_LOG="$LOG2" bash "$HERE/needs-decision.sh" $'said "no"\\ and\nbroke' )
bad=$(node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n");let b=0;for(const x of l){try{JSON.parse(x)}catch{b++}}console.log(b)' "$LOG2")
assert_eq "$bad" "0" "every line is valid JSON"
assert_eq "$(wc -l < "$LOG2" | tr -d ' ')" "2" "two lines, newline in reason did not split one"
assert_eq "$(node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n");console.log(JSON.parse(l[0]).reason)' "$LOG2")" 'said "no"\ and broke' "reason round-trips with escapes flattened"

# A reason is required.
out=$(cd "$REPO" && EVENTS_LOG="$LOG" bash "$HERE/needs-decision.sh" 2>&1); rc=$?
assert_eq "$rc" "1" "no reason exits 1"
assert_eq "$(printf '%s' "$out" | grep -c 'Usage:')" "1" "no reason prints usage"

if [ "$fail" -eq 0 ]; then echo "PASS: needs-decision.sh tests"; else exit 1; fi
