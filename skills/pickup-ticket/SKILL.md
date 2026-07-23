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

4. **Implement.** Check the environment for `IMPL_MODEL` (e.g. `echo "$IMPL_MODEL"`).
   - If it is **set**, dispatch the implementation to subagents so it runs on
     that model: use `superpowers:subagent-driven-development` and pass
     `model: <IMPL_MODEL>` to each implementation subagent. The
     planning/orchestration session (this one) stays on its own model.
   - If it is **unset**, invoke `superpowers:executing-plans` and implement
     in-session.
   Either way, implement the plan task-by-task using
   `superpowers:test-driven-development`.

5. **Self-review and fix.** With the tests green, run one round of code review on
   the changes before finishing (before any PR) — invoke
   `superpowers:requesting-code-review`. Triage the findings by severity and act:
   - **Critical / High / Medium** → fix every one of them.
   - **Low** → fix only if the change is small and localized; otherwise leave it
     and note it in the summary.
   Re-run the full test suite after fixing and loop until it is green again.

6. **Finish at green.** When the full test suite passes, run the
   end-of-implementation steps:
   - **Move the ticket to the Review column** in the kanban board (not Done —
     Review signals it's ready for someone to review).
   - **Spin up the local server on this session's tmux pane** so the change can
     be inspected running.
   Then STOP. Print a summary of what changed and the test result. Do **not**
   create a PR, push, or open a diff — that stays manual.

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
