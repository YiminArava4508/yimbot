#!/bin/bash
# Checks that pickup-ticket's conditional workflows live in their own skills
# and that pickup hands off to them.
set -u
cd "$(dirname "$0")/.."

fail=0
SK=skills
PICKUP=$SK/pickup-ticket/SKILL.md

has() { # file string label
  grep -qF -- "$2" "$1" 2>/dev/null || { echo "FAIL: $3 - [$2] not in $1"; fail=1; }
}
lacks() { # file string label
  if grep -qF -- "$2" "$1" 2>/dev/null; then echo "FAIL: $3 - [$2] still in $1"; fail=1; fi
}
frontmatter_ok() { # name
  local f="$SK/$1/SKILL.md"
  [ -f "$f" ] || { echo "FAIL: $f missing"; fail=1; return; }
  has "$f" "name: $1" "$1 frontmatter name"
  lacks "$f" "user-invocable" "$1 is not user-invocable"
}

frontmatter_ok spike-ticket
has "$SK/spike-ticket/SKILL.md" "Leave no local-only work" "spike steps moved"
lacks "$PICKUP" "## Spike Tickets" "spike section removed from pickup"
has "$PICKUP" 'invoke the `spike-ticket` skill now' "pickup hands off spikes"

frontmatter_ok archive-flag-ticket
has "$SK/archive-flag-ticket/SKILL.md" "Fail closed." "flag checklist moved"
has "$SK/archive-flag-ticket/SKILL.md" "Every other prod change still needs a" "posthog exception moved"
lacks "$PICKUP" "## Flag Archive Tickets" "flag section removed from pickup"
lacks "$PICKUP" "**Flag Archive Tickets**" "no stale flag section refs"
has "$PICKUP" 'invoke the `archive-flag-ticket` skill now' "pickup hands off flag archives"
has "$PICKUP" 'through the `archive-flag-ticket` skill' "rubric points at the skill"

S="$SK/split-ticket-prs/SKILL.md"
frontmatter_ok split-ticket-prs
has "$S" "touch .yimbot-split-parent" "split flow moved"
has "$S" "git rebase --onto main <sibling-branch>" "reroot moved"
has "$S" "same \`UAT:\` line" "every slice PR carries the local UAT line"
has "$S" "no preview walk-through" "slices get no walk-through"
has "$S" "every slice PR as a draft" "failed UAT drafts every slice"
lacks "$PICKUP" "touch .yimbot-split-parent" "split flow removed from pickup"
lacks "$PICKUP" "rebase --onto main" "reroot removed from pickup"
has "$PICKUP" "Hard limit: 500 LOC" "pickup keeps the limit"
has "$PICKUP" "SPLIT_TICKETS" "pickup keeps the exception"
has "$PICKUP" 'invoke the `split-ticket-prs` skill now' "pickup hands off splits"

U="$SK/ticket-uat/SKILL.md"
frontmatter_ok ticket-uat
has "$U" "## Local phase" "local phase"
has "$U" "## Preview phase" "preview phase"
has "$U" "pnpm test:playwright tests/" "runs through the heavy queue"
lacks "$U" "npx playwright" "no queue bypass"
has "$U" "~/.cache/yimbot/uat/" "fixed screenshot path"
lacks "$U" '$SHOT' "no shell var across calls"
lacks "$U" 'BASE_URL=$(' "no captured base url var"
has "$U" "timeout: 600000" "wait has a long bash timeout"
has "$U" "exits 2" "force retry only on timeout"
has "$U" "react-ui/.env.local" "credentials source"
has "$U" "PLAYWRIGHT_USERNAME" "credentials checked"
has "$U" "env skip" "auth failure is an env skip"
has "$U" "rm -f ~/.cache/yimbot/uat/" "cleanup after failed upload"
has "$U" "single-PR" "preview walk-through only for single-PR tickets"
lacks "$PICKUP" "7b. Preview walk-through" "7b removed from pickup"
lacks "$PICKUP" "--add-label preview" "preview label rule moved"
lacks "$PICKUP" "step 7b" "no stale 7b refs"
has "$PICKUP" 'invoke the `ticket-uat` skill now (local phase)' "pickup hands off local UAT"
has "$PICKUP" 'invoke the `ticket-uat` skill now (preview phase)' "pickup hands off preview UAT"

if [ "$fail" -eq 0 ]; then echo "PASS: skills split tests"; fi
exit "$fail"
