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

if [ "$fail" -eq 0 ]; then echo "PASS: skills split tests"; fi
exit "$fail"
