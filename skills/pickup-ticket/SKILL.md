---
name: pickup-ticket
description: Use when picking up a Linear/Shortcut ticket in a fresh worktree session — plans the work, resolves its own uncertainties, and implements to a green PR; pauses only for genuinely dangerous, hard-to-reverse changes.
user-invocable: true
---

# Pickup Ticket

Take a ticket from "just fetched" all the way to a green, ready-for-review PR,
resolving your own uncertainties as you go. Only genuinely dangerous,
hard-to-reverse work pauses for a human "go". The caller has already fetched the
ticket and read its description, acceptance criteria, and comments before
invoking this skill.

**Never stop to ask permission to plan or to implement, and never stop just
because you have an open question or a design choice to make.** Resolving those
yourself is the job.

## Flow

1. **Plan.** Invoke `superpowers:writing-plans` and produce the implementation
   plan for this ticket. Design/plan docs are written under `docs/superpowers/`.
   When the plan surfaces an **open question or a design fork**, resolve it
   yourself: pick the simplest reversible option that satisfies the ticket's
   acceptance criteria, and record the decision plus the rejected alternative in
   the plan (a short "Decisions" note). Do not pause to ask.

2. **Classify** the plan against the Hard-Stop Rubric below.

3. **Branch:**
   - **HARD STOP** → print a concise summary naming which hard-stop trigger(s)
     fired and the path to the plan, then **STOP and wait for the human to say
     "go"** (or to amend the plan). Do not write code.
   - **Otherwise** → announce "No hard-stop triggers (<one-line reason>);
     implementing automatically." then continue to step 4.

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

6. **Ship at green.** When the full test suite passes, run the
   end-of-implementation steps in this order:
   - **Push** the branch to origin (`git push -u origin HEAD`).
   - **Open a PR** with `gh pr create` as a **non-draft** PR (so the daemon's
     review step can pick up review comments). Title = the ticket summary; body
     = a short "what changed / why / test result", any **Decisions** you made to
     resolve uncertainty (with the alternative you rejected), and the ticket
     reference so the tracker auto-links the PR. Follow the repo's commit/PR
     conventions: never mention Claude, Claude Code, or AI, and add no "Generated
     with" or "Co-Authored-By" trailers.
   - **Move the ticket to the Review column** in the kanban board (not Done —
     Review signals the PR is ready for someone to review).
   - **Spin up the local server on this session's tmux pane** so the change can
     be inspected running.
   Then STOP. Print a summary of what changed, the PR URL, and the test result.

## Hard-Stop Rubric

Pause for a human "go" **only** if the plan involves one of the following —
genuinely dangerous, hard-to-reverse work:

- A **database migration or schema change**.
- **Authentication**.
- **Billing or payments**.
- A **destructive or irreversible infrastructure/data operation** (deleting
  resources, data-destroying commands, and the like).

Nothing else pauses. Touching many files, touching shared or core code, or the
plan containing an open question is **not** a reason to stop — resolve it and
keep going.

When unsure, **bias toward proceeding**: resolve the uncertainty with a
documented default and implement. Pause only when a hard-stop trigger clearly
and unavoidably applies, and only because the change is dangerous or
irreversible — never merely because you have a question.
