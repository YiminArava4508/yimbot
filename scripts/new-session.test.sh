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

# Resume mode (SESSION_RESUME) reattaches to the prior conversation with
# --continue and, in launch_claude_in, sends no seed prompt.
assert_eq "$(SESSION_RESUME=1 build_claude_cmd | grep -c -- '--continue')" "1" "resume mode adds --continue"
assert_eq "$(build_claude_cmd | grep -c -- '--continue')" "0" "no --continue without resume mode"

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

# The hook emitter helpers survive sourcing.
assert_defined event_key_from_branch
assert_defined emit_hook_event

# event_key_from_branch mirrors deriveKey({branch}): eng-/sc- ticket branches map
# to the uppercased TICKET-NUMBER; any other branch is its own key.
assert_eq "$(event_key_from_branch eng-123-add-widget)" "ENG-123" "eng branch -> ENG-123"
assert_eq "$(event_key_from_branch SC-42-thing)" "SC-42" "sc branch (any case) -> SC-42"
assert_eq "$(event_key_from_branch spike-refactor)" "spike-refactor" "non-ticket branch is its own key"

# emit_hook_event appends one JSON line keyed by the worktree's branch. Run it in
# a throwaway git repo so git branch --show-current resolves.
HOOK_REPO=$(mktemp -d)
git -C "$HOOK_REPO" init -q -b eng-7-demo
git -C "$HOOK_REPO" commit -q --allow-empty -m init
HOOK_LOG=$(mktemp)
( cd "$HOOK_REPO" && EVENTS_LOG="$HOOK_LOG" emit_hook_event needs_input )
assert_eq "$(wc -l < "$HOOK_LOG" | tr -d ' ')" "1" "emit_hook_event writes one line"
assert_eq "$(grep -c '"kind":"needs_input"' "$HOOK_LOG")" "1" "line carries the kind"
assert_eq "$(grep -c '"key":"ENG-7"' "$HOOK_LOG")" "1" "line is keyed ENG-7 from the branch"
# The hand-back kinds ride the same generic emitter, keyed from the branch.
HOOK_LOG_HB=$(mktemp)
( cd "$HOOK_REPO" && EVENTS_LOG="$HOOK_LOG_HB" emit_hook_event needs_decision )
( cd "$HOOK_REPO" && EVENTS_LOG="$HOOK_LOG_HB" emit_hook_event review_findings )
assert_eq "$(grep -c '"kind":"needs_decision"' "$HOOK_LOG_HB")" "1" "emit_hook_event writes needs_decision"
assert_eq "$(grep -c '"kind":"review_findings"' "$HOOK_LOG_HB")" "1" "emit_hook_event writes review_findings"
assert_eq "$(grep -c '"key":"ENG-7"' "$HOOK_LOG_HB")" "2" "hand-back lines are keyed ENG-7 from the branch"
rm -f "$HOOK_LOG_HB"
# A second argument becomes the reason field; without one the field is absent.
HOOK_LOG_REASON=$(mktemp)
( cd "$HOOK_REPO" && EVENTS_LOG="$HOOK_LOG_REASON" emit_hook_event flagged decision )
( cd "$HOOK_REPO" && EVENTS_LOG="$HOOK_LOG_REASON" emit_hook_event needs_decision )
assert_eq "$(grep -c '"kind":"flagged".*"reason":"decision"' "$HOOK_LOG_REASON")" "1" "reason arg lands as the reason field"
assert_eq "$(grep -c '"kind":"needs_decision"' "$HOOK_LOG_REASON")" "1" "reason-less call still writes its line"
assert_eq "$(grep -c '"kind":"needs_decision".*"reason"' "$HOOK_LOG_REASON")" "0" "no reason arg, no reason field"
rm -f "$HOOK_LOG_REASON"
# No EVENTS_LOG is a silent no-op, not an error.
( cd "$HOOK_REPO" && unset EVENTS_LOG; emit_hook_event needs_input )
assert_eq "$?" "0" "emit_hook_event with no EVENTS_LOG exits 0"

# emit_notification_event filters Claude Code's Notification payload: only a
# notification that means a human is blocking becomes a needs_input line.
assert_defined emit_notification_event
notify_payload() {
  printf '{"session_id":"abc","hook_event_name":"Notification","message":"m","notification_type":"%s"}' "$1"
}
NOTIFY_QUIET_LOG=$(mktemp)
for t in idle_prompt auth_success elicitation_complete elicitation_response agent_completed \
         computer_use_enter computer_use_exit push_notification; do
  ( cd "$HOOK_REPO" && EVENTS_LOG="$NOTIFY_QUIET_LOG" emit_notification_event <<<"$(notify_payload "$t")" )
done
assert_eq "$(wc -c < "$NOTIFY_QUIET_LOG" | tr -d ' ')" "0" "quiet notification types write nothing"

# A pretty-printed payload repeating the key must still resolve to one type: the
# match takes the first occurrence, so the quiet list still matches.
NOTIFY_MULTILINE_LOG=$(mktemp)
( cd "$HOOK_REPO" && EVENTS_LOG="$NOTIFY_MULTILINE_LOG" emit_notification_event <<<'{
  "notification_type": "idle_prompt",
  "agent": { "notification_type": "idle_prompt" }
}' )
assert_eq "$(wc -c < "$NOTIFY_MULTILINE_LOG" | tr -d ' ')" "0" "a multi-line payload still reads as quiet"
rm -f "$NOTIFY_MULTILINE_LOG"

# worker_permission_prompt is emitted by the CLI but absent from its documented
# enum: the ignore-list must flag it rather than swallow it.
for t in permission_prompt elicitation_dialog agent_needs_input worker_permission_prompt; do
  NOTIFY_ONE_LOG=$(mktemp)
  ( cd "$HOOK_REPO" && EVENTS_LOG="$NOTIFY_ONE_LOG" emit_notification_event <<<"$(notify_payload "$t")" )
  assert_eq "$(grep -c '"kind":"needs_input"' "$NOTIFY_ONE_LOG")" "1" "$t emits one needs_input"
  assert_eq "$(grep -c '"key":"ENG-7"' "$NOTIFY_ONE_LOG")" "1" "$t line is keyed ENG-7 from the branch"
  rm -f "$NOTIFY_ONE_LOG"
done

# Ignore-list fallthrough: a type this build has never seen, a payload with no
# notification_type, and empty stdin all still flag rather than going quiet.
NOTIFY_FALLTHROUGH_LOG=$(mktemp)
( cd "$HOOK_REPO" && EVENTS_LOG="$NOTIFY_FALLTHROUGH_LOG" emit_notification_event <<<"$(notify_payload some_future_block)" )
( cd "$HOOK_REPO" && EVENTS_LOG="$NOTIFY_FALLTHROUGH_LOG" emit_notification_event <<<'{"hook_event_name":"Notification","message":"m"}' )
( cd "$HOOK_REPO" && EVENTS_LOG="$NOTIFY_FALLTHROUGH_LOG" emit_notification_event </dev/null )
assert_eq "$?" "0" "empty stdin exits 0"
assert_eq "$(grep -c '"kind":"needs_input"' "$NOTIFY_FALLTHROUGH_LOG")" "3" "unknown type, absent type, and empty stdin all flag"

# A terminal on stdin means no notification fired at all (someone sourced the
# script and called the function by hand), which must not stamp a flag. script(1)
# supplies the pty; without one this asserts nothing, so skip it when absent.
if command -v script >/dev/null 2>&1; then
  NOTIFY_TTY_LOG=$(mktemp)
  script -qec "cd $HOOK_REPO && EVENTS_LOG=$NOTIFY_TTY_LOG bash -c 'source $(dirname "$0")/new-session.sh; emit_notification_event'" /dev/null >/dev/null 2>&1
  assert_eq "$(wc -c < "$NOTIFY_TTY_LOG" | tr -d ' ')" "0" "a tty on stdin writes nothing"
  rm -f "$NOTIFY_TTY_LOG"
fi
rm -f "$NOTIFY_QUIET_LOG" "$NOTIFY_FALLTHROUGH_LOG"

# A branch name containing a double quote (legal in git refs) must not break
# the JSON line: event_key_from_branch's fallthrough echoes it raw, so
# emit_hook_event must escape it before interpolating.
git -C "$HOOK_REPO" checkout -q -b 'weird"branch'
HOOK_LOG2=$(mktemp)
( cd "$HOOK_REPO" && EVENTS_LOG="$HOOK_LOG2" emit_hook_event needs_input )
assert_eq "$(node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim(); const o=JSON.parse(l); process.stdout.write(o.key)' "$HOOK_LOG2")" 'weird"branch' "malformed-char branch key round-trips through valid JSON"
rm -rf "$HOOK_REPO" "$HOOK_LOG" "$HOOK_LOG2"

# The session settings file parses and wires both attention hooks to the emitter.
SETTINGS_JSON="$(cd "$(dirname "$0")" && pwd)/../settings/session-settings.json"
assert_eq "$(node -e 'const h=require(process.argv[1]).hooks||{}; process.stdout.write(String(!!h.Notification&&!!h.UserPromptSubmit))' "$SETTINGS_JSON")" "true" "settings define both attention hooks"
# Read the Notification entry's own command rather than grepping the whole file,
# so wiring another hook to emit_hook_event never trips these.
NOTIFY_CMD=$(node -e 'process.stdout.write(require(process.argv[1]).hooks.Notification[0].hooks[0].command)' "$SETTINGS_JSON")
assert_eq "$(printf '%s' "$NOTIFY_CMD" | grep -c 'then emit_notification_event')" "1" "Notification hook runs the notification filter"
# Fallback: a stale ~/new-session.sh without the filter must degrade to the old
# unconditional flag rather than silently disabling the hook.
assert_eq "$(printf '%s' "$NOTIFY_CMD" | grep -c 'elif command -v emit_hook_event .* then emit_hook_event needs_input')" "1" "Notification hook falls back to the generic emitter"
assert_eq "$(grep -c 'emit_hook_event input_received' "$SETTINGS_JSON")" "1" "UserPromptSubmit hook emits input_received"

if [ "$fail" -eq 0 ]; then echo "PASS: new-session.sh helper tests"; else exit 1; fi
