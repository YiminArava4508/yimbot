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
   the plan (a short "Decisions" note). Do not pause to ask. If the work clearly
   won't fit under the **PR Size Limits** below, plan it as a series of
   shippable slices up front (see that section).

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
   - **Check PR size** against the **PR Size Limits** below. If the branch is
     over the hard limit, split it into a series of smaller PRs *before* pushing
     — do not open one oversized PR.
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

The PR is the human checkpoint. Code that only takes effect once the PR is
merged or deployed — including **database migrations, schema changes,
authentication, and billing/payments logic**, even breaking ones — is **not** a
reason to pause. Write it, ship the PR, and let the human review it there.

Pause for a human "go" **only** when implementation itself would **destroy or
mutate real resources right now**, before any review can happen:

- Running a migration or any destructive command against a real (dev, staging,
  or prod) database, rather than just committing the migration file.
- Deleting or overwriting real infrastructure, data, or resources.
- Any data-destroying or otherwise irreversible command executed during
  implementation.

Nothing else pauses. Writing migration, auth, or billing code, touching many
files, touching shared or core code, or the plan containing an open question is
**not** a reason to stop — resolve it and keep going.

When unsure, **bias toward proceeding**: resolve the uncertainty with a
documented default and implement. Pause only when running the work itself would
irreversibly change real resources before the PR can be reviewed — never merely
because the change is sensitive, breaking, or you have a question.

## PR Size Limits

Keep PRs small enough to review. Measure the branch's changed lines with
`git diff main...HEAD --stat` (against the base branch; ignore generated files,
lockfiles, and snapshots).

- **Target: under 500 LOC.** Aim to land every PR under this.
- **Hard limit: 1000 LOC.** A PR whose changes exceed ~1000 LOC **must** be
  split into multiple smaller PRs before shipping — no exceptions.

Split into **normal, independent PRs off the base branch — never GitHub stacked
PRs.** Use `worktree-workflow`'s "Splitting a PR into Multiple Smaller PRs" for
the mechanics (a worktree + branch per slice), but **skip its optional
stacked-PR step (Step 5)**. Each slice must be independently reviewable and
mergeable on its own.

Mark every PR in a split as part of a series in its **title and description** —
e.g. title `[1/3] <summary>` and a body line listing the sibling PRs and their
order. Push and open the whole series (all non-draft), then move the ticket to
Review once.

Prefer to catch large scope at **plan time**: if the plan clearly exceeds ~500
LOC, structure it as a series of shippable slices from the start rather than
splitting one giant branch afterward.
