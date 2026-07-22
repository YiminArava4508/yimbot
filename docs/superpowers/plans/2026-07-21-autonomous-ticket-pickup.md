# Autonomous Ticket Pickup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a ticket triggers a fresh worktree session, auto-implement small/localized plans to green tests and pause for an explicit "go" only on risky plans — removing the manual plan→implement handoff.

**Architecture:** A new user-level skill `~/.claude/skills/pickup-ticket/SKILL.md` encodes the flow (plan → classify risk → branch) and the risk rubric. `~/new-session.sh` is refactored to build its Claude seed prompt via a small, unit-testable `seed_prompt_for()` function that now hands off to the pickup-ticket skill instead of "stop after plan." Risk classification is performed by Claude *after* planning (the only point where plan scope is known), not by the daemon.

**Tech Stack:** Bash (personal helper scripts), Markdown (Claude Code skill), Claude Code skills (`superpowers:writing-plans`, `superpowers:executing-plans`, `superpowers:test-driven-development`).

## Global Constraints

- Out-of-repo files (`~/new-session.sh`, `~/.claude/skills/pickup-ticket/SKILL.md`) are **not** under git. Before editing an existing out-of-repo file, make a timestamped backup: `cp <file> <file>.bak.$(date +%s)` — matching the existing `new-session.sh.bak.<ts>` convention. New files need no backup. Do not attempt `git commit` for these paths.
- Only the yimbot repo files (this plan, the spec) are committed to git, on branch `build-watcher`.
- Implementation must **stop at green tests** — no PR, no push, no diff creation. That boundary is a hard requirement of the spec.
- Preserve existing `new-session.sh` behavior for every non-ticket session name (bare `claude`) and all tmux/worktree setup unchanged.
- Seed prompt text must contain **no double-quote characters** (it is embedded inside `claude \"$CLAUDE_PROMPT\"` in a `tmux send-keys`), matching the current script.

---

## File Structure

- `~/.claude/skills/pickup-ticket/SKILL.md` — **new.** Source of truth for the autonomous pickup flow and the risk rubric. Invoked by name from the seed prompt; also `/pickup-ticket` by hand.
- `~/new-session.sh` — **modified.** Extract `seed_prompt_for()` (pure, testable); add a source-guard so the file can be sourced by tests without running session setup; rewrite the seed block to hand off to the pickup-ticket skill and warn if the skill is missing.
- `~/new-session.test.sh` — **new.** Plain-bash assertion tests for `seed_prompt_for()` (no test framework/deps).
- `docs/superpowers/plans/2026-07-21-autonomous-ticket-pickup.md` — this plan (committed to yimbot).

---

## Task 1: Create the pickup-ticket skill

**Files:**
- Create: `~/.claude/skills/pickup-ticket/SKILL.md`

**Interfaces:**
- Consumes: nothing (entry point).
- Produces: a skill invocable as "the pickup-ticket skill" / `/pickup-ticket`. Task 2's seed prompt references it by that name. Contract: the caller has already fetched the ticket and read its description/AC/comments before invoking.

- [ ] **Step 1: Write the skill file**

Create `~/.claude/skills/pickup-ticket/SKILL.md` with exactly this content:

```markdown
---
name: pickup-ticket
description: Use when picking up a Linear/Shortcut ticket in a fresh worktree session — plans the work, auto-implements low-risk plans to green tests, and pauses for approval on risky ones.
user-invocable: true
---

# Pickup Ticket

Take a ticket from "just fetched" to either implemented-with-green-tests (when
the plan is small and localized) or a paused, ready-for-your-"go" plan (when the
plan is risky). The caller has already fetched the ticket and read its
description, acceptance criteria, and comments before invoking this skill.

## Flow

1. **Plan.** Invoke `superpowers:writing-plans` and produce the implementation
   plan for this ticket. Design/plan docs are written under `docs/superpowers/`.

2. **Classify** the plan against the Risk Rubric below.

3. **Branch:**
   - **HIGH RISK** → print a concise summary naming which rubric trigger(s)
     fired and the path to the plan, then **STOP and wait for the human to say
     "go"** (or to amend the plan). Do not write code.
   - **LOW RISK** → announce "Plan is low-risk (<one-line reason>); implementing
     automatically." then continue to step 4.

4. **Implement.** Invoke `superpowers:executing-plans` and implement the plan
   task-by-task using `superpowers:test-driven-development`.

5. **Stop at green.** When the full test suite passes, STOP. Print a summary of
   what changed and the test result. Do **not** create a PR, push, or open a
   diff — that stays manual.

## Risk Rubric

Treat the plan as **HIGH RISK** if **any** of the following hold; otherwise it
is **LOW RISK**:

- The plan involves a **database migration or schema change**.
- The plan touches **authentication, billing/payments, or shared/core
  libraries** (code many other modules depend on).
- The plan touches **more than 8 files**.
- The ticket carries a **risk-ish label** (e.g. `migration`, `infra`,
  `breaking`, `security`) or an estimate above the team's "small" threshold.
- The plan itself contains **open questions or flagged uncertainty**.

When unsure whether a trigger applies, treat it as HIGH RISK and pause. Bias
toward asking.
```

- [ ] **Step 2: Verify the file exists with valid frontmatter and required sections**

Run:
```bash
f=~/.claude/skills/pickup-ticket/SKILL.md
head -1 "$f" | grep -qx -- '---' && \
grep -q '^name: pickup-ticket$' "$f" && \
grep -q '^description: ' "$f" && \
grep -q '^## Flow$' "$f" && \
grep -q '^## Risk Rubric$' "$f" && \
echo "OK: skill present with frontmatter + Flow + Risk Rubric"
```
Expected: `OK: skill present with frontmatter + Flow + Risk Rubric`

- [ ] **Step 3: No commit**

Out-of-repo new file; nothing to back up or commit. Proceed to Task 2.

---

## Task 2: Wire new-session.sh to the pickup-ticket skill

**Files:**
- Modify: `~/new-session.sh` (add `PICKUP_SKILL` var; add `seed_prompt_for()`; add source-guard; rewrite seed block at current lines 73-86)
- Create: `~/new-session.test.sh`

**Interfaces:**
- Consumes: the `pickup-ticket` skill from Task 1 (referenced by name in the prompt text; existence checked at `~/.claude/skills/pickup-ticket/SKILL.md`).
- Produces: `seed_prompt_for(name)` → echoes the fetch+pickup seed prompt for `sc-<id>-…` and `eng-<id>-…` names, or empty string otherwise. Consumed by the seed block and by `new-session.test.sh`.

- [ ] **Step 1: Back up the current script**

Run:
```bash
cp ~/new-session.sh ~/new-session.sh.bak.$(date +%s) && ls -1 ~/new-session.sh.bak.* | tail -1
```
Expected: prints the path of a new `~/new-session.sh.bak.<timestamp>` file.

- [ ] **Step 2: Write the failing test**

Create `~/new-session.test.sh` with exactly this content:

```bash
#!/bin/bash
# Unit tests for seed_prompt_for() in new-session.sh. Sourcing new-session.sh
# must load its functions WITHOUT running session setup (source-guard).
set -u
source ~/new-session.sh

fail=0
assert_contains() { # haystack needle label
  case "$1" in
    *"$2"*) ;;
    *) echo "FAIL: $3 — expected to contain: [$2]"; echo "   got: [$1]"; fail=1;;
  esac
}
assert_empty() { # value label
  if [ -n "$1" ]; then echo "FAIL: $2 — expected empty, got: [$1]"; fail=1; fi
}

# eng-<id>-… → Linear fetch + pickup-ticket handoff
p=$(seed_prompt_for "eng-42-add-widget")
assert_contains "$p" "Linear issue ENG-42" "eng issue id"
assert_contains "$p" "mcp__linear-server__get_issue" "eng MCP tool"
assert_contains "$p" "pickup-ticket skill" "eng pickup handoff"

# sc-<id>-… → Shortcut fetch + pickup-ticket handoff
p=$(seed_prompt_for "sc-1337-fix-bug")
assert_contains "$p" "Shortcut story 1337" "sc story id"
assert_contains "$p" "mcp__shortcut__stories-get-by-id" "sc MCP tool"
assert_contains "$p" "pickup-ticket skill" "sc pickup handoff"

# unrecognized name → empty (bare claude, no seed)
assert_empty "$(seed_prompt_for "random-scratch")" "non-ticket empty"

if [ "$fail" -eq 0 ]; then echo "PASS: seed_prompt_for tests"; else exit 1; fi
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bash ~/new-session.test.sh`
Expected: FAIL — `seed_prompt_for` is not defined yet, and sourcing the current script runs the session-setup body (errors on missing `$NAME`). Either way it does not print `PASS: seed_prompt_for tests`.

- [ ] **Step 4: Add the config var and the `seed_prompt_for` function**

In `~/new-session.sh`, replace the top block (current lines 3-10):

```bash
NAME=$1
SETUP_SCRIPT=~/setup-worktree.sh

log() { echo "[$(date '+%H:%M:%S')] $*"; }
die() {
  log "ERROR: $*"
  exit 1
}
```

with:

```bash
SETUP_SCRIPT=~/setup-worktree.sh
PICKUP_SKILL=~/.claude/skills/pickup-ticket/SKILL.md

log() { echo "[$(date '+%H:%M:%S')] $*"; }
die() {
  log "ERROR: $*"
  exit 1
}

# Build the Claude seed prompt for a session name. Echoes a fetch-then-handoff
# prompt for recognized ticket sessions (sc-<id>-… / eng-<id>-…), or nothing
# for any other name. Kept as a pure function so it can be unit-tested.
seed_prompt_for() {
  local name=$1
  if [[ "$name" =~ ^sc-([0-9]+)- ]]; then
    printf 'Fetch Shortcut story %s via the Shortcut MCP (mcp__shortcut__stories-get-by-id) and read its description, acceptance criteria, and comments. Then invoke the pickup-ticket skill and follow it exactly.' "${BASH_REMATCH[1]}"
  elif [[ "$name" =~ ^eng-([0-9]+)- ]]; then
    printf 'Fetch Linear issue ENG-%s via the Linear MCP (mcp__linear-server__get_issue) and read its description and comments. Then invoke the pickup-ticket skill and follow it exactly.' "${BASH_REMATCH[1]}"
  fi
}

# When sourced (e.g. by new-session.test.sh) load the functions above and stop;
# only run session setup when the script is executed directly.
(return 0 2>/dev/null) && return 0

NAME=$1
```

- [ ] **Step 5: Rewrite the seed block to hand off to the skill**

In `~/new-session.sh`, replace the seed block (current lines 73-86):

```bash
# If launched from shortcut-helper (name is sc-<storyId>-<slug>), seed the
# Claude session with a prompt that asks it to look up the ticket via the
# Shortcut MCP and draft an implementation plan before any code is written.
if [[ "$NAME" =~ ^sc-([0-9]+)- ]]; then
  STORY_ID="${BASH_REMATCH[1]}"
  CLAUDE_PROMPT="Fetch Shortcut story ${STORY_ID} via the Shortcut MCP (mcp__shortcut__stories-get-by-id) and read its description, acceptance criteria, and comments. Then invoke the superpowers:writing-plans skill and use it to produce the implementation plan for this ticket. Do not write code — stop after the plan is written."
  tmux send-keys -t "$NAME:Claude" "claude \"$CLAUDE_PROMPT\"" C-m
elif [[ "$NAME" =~ ^eng-([0-9]+)- ]]; then
  ISSUE_ID="ENG-${BASH_REMATCH[1]}"
  CLAUDE_PROMPT="Fetch Linear issue ${ISSUE_ID} via the Linear MCP (mcp__linear-server__get_issue) and read its description and comments. Then invoke the superpowers:writing-plans skill and use it to produce the implementation plan for this ticket. Do not write code — stop after the plan is written."
  tmux send-keys -t "$NAME:Claude" "claude \"$CLAUDE_PROMPT\"" C-m
else
  tmux send-keys -t "$NAME:Claude" "claude" C-m
fi
```

with:

```bash
# Seed the Claude window. For ticket sessions (sc-<id>-… / eng-<id>-…), fetch
# the ticket then hand off to the pickup-ticket skill, which auto-implements
# low-risk plans to green tests and pauses for a "go" on risky ones. Any other
# session name gets a bare claude.
CLAUDE_PROMPT=$(seed_prompt_for "$NAME")
if [ -n "$CLAUDE_PROMPT" ]; then
  [ -f "$PICKUP_SKILL" ] || log "WARN: pickup-ticket skill not found at $PICKUP_SKILL; Claude will fetch the ticket but have no pickup flow to follow"
  tmux send-keys -t "$NAME:Claude" "claude \"$CLAUDE_PROMPT\"" C-m
else
  tmux send-keys -t "$NAME:Claude" "claude" C-m
fi
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bash ~/new-session.test.sh`
Expected: `PASS: seed_prompt_for tests`

- [ ] **Step 7: Verify the executed script still parses and runs its setup path**

Confirm the source-guard did not break direct execution (usage guard still fires):

Run: `bash ~/new-session.sh` (no args)
Expected: prints `Usage: /home/ymbo/new-session.sh <name>` (or `Usage: ... <name>`) and exits — i.e. the main body runs when executed directly.

Also syntax-check: `bash -n ~/new-session.sh` — Expected: no output (exit 0).

- [ ] **Step 8: No git commit**

`~/new-session.sh` and `~/new-session.test.sh` are out-of-repo. The Step-1 backup is the rollback point. Do not `git commit` these paths.

---

## Task 3: End-to-end validation (manual)

**Files:** none — validates the wired system per the spec's Testing section.

**Interfaces:**
- Consumes: Task 1 skill + Task 2 wiring.
- Produces: confirmation the two branches behave as specified.

- [ ] **Step 1: Confirm the seed prompt now references the skill (not "stop after plan")**

Run:
```bash
grep -n 'pickup-ticket skill' ~/new-session.sh && \
! grep -q 'stop after the plan is written' ~/new-session.sh && \
echo "OK: seed handoff updated, old stop-after-plan text gone"
```
Expected: matching lines for the handoff, then `OK: seed handoff updated, old stop-after-plan text gone`.

- [ ] **Step 2: Confirm daemon regression suite is unaffected**

The change is prompt/skill only; daemon TypeScript is untouched. Run:
```bash
cd ~/Work/yimbot && pnpm typecheck && pnpm test
```
Expected: typecheck clean and all daemon tests pass (27/27 per current baseline).

- [ ] **Step 3: Low-risk live check**

Move a genuinely small Linear issue in team Engineering to *In Progress* (or run `~/new-session.sh eng-<id>-<slug>` directly). Attach to the session's Claude window and confirm: it fetches the ticket, writes a plan, announces "Plan is low-risk …", and proceeds into implementation without you re-prompting, stopping at green tests with a summary and **no** PR/push.

- [ ] **Step 4: High-risk live check**

Trigger a ticket whose plan hits a rubric trigger (e.g. one that requires a DB migration). Confirm the session writes the plan, prints a summary naming the fired trigger and the plan path, and **stops to wait for "go"** — no code written.

- [ ] **Step 5: Commit the plan doc**

```bash
cd ~/Work/yimbot
git add docs/superpowers/plans/2026-07-21-autonomous-ticket-pickup.md
git commit -m "docs: implementation plan for autonomous ticket pickup"
```

---

## Self-Review

**Spec coverage:**
- Seed prompt shrinks to fetch + follow pickup flow → Task 2 Steps 4-5. ✓
- Flow (fetch → writing-plans → classify → branch → stop at green) → Task 1 skill body. ✓
- Risk rubric (migration, auth/billing/shared, >8 files, label/estimate, open questions) → Task 1 Risk Rubric, verbatim from spec. ✓
- Classification lives with Claude post-plan → encoded in skill flow order (classify is step 2, after writing-plans); daemon untouched (Task 3 Step 2). ✓
- Stop at green tests, no PR/push → skill step 5 + Global Constraints + Task 3 Steps 3-4. ✓
- Reusable across eng-*/sc-* → single skill; both branches of `seed_prompt_for` reference it (Task 2 Step 4, tested Task 2 Step 2). ✓
- Existence check / warn when skill missing → Task 2 Step 5 `[ -f "$PICKUP_SKILL" ] || log WARN`. ✓
- In-Review trigger unchanged, session/worktree creation unchanged → Global Constraints; no task touches them. ✓

**Placeholder scan:** No TBD/TODO; all file contents and commands are literal. ✓

**Type/name consistency:** `seed_prompt_for` and `PICKUP_SKILL` names match across Task 2 definition, seed block, and `new-session.test.sh`. Skill referenced consistently as "the pickup-ticket skill" in both prompt branches and at path `~/.claude/skills/pickup-ticket/SKILL.md` in the existence check and Task 1. ✓
