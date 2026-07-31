---
name: pickup-ticket
description: Use when picking up a Linear/Shortcut ticket in a fresh worktree session, plans the work, resolves its own uncertainties, and implements to a green PR; pauses only for genuinely dangerous, hard-to-reverse changes.
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
   Before designing any new function, helper, component, type, or module,
   deliberately search the repo for existing functionality that already does
   something similar, and design to reuse or extend it; plan new code only
   where nothing existing fits. When the plan surfaces an **open question or a
   design fork**, resolve it yourself: pick the simplest reversible option
   that satisfies the ticket's acceptance criteria, and record the decision
   plus the rejected alternative in the plan (a short "Decisions" note),
   including what existing code was reused or why a candidate did not fit. Do
   not pause to ask. If the work clearly won't fit under the **PR Size
   Limits** below, plan it as a series of shippable slices up front (see that
   section).

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
   the changes before finishing (before any PR): invoke
   `superpowers:requesting-code-review`. Triage the findings by severity and act:
   - **Critical / High / Medium** → fix every one of them.
   - **Low** → fix only if the change is small and localized; otherwise leave it
     and note it in the summary.
   Re-run the full test suite after fixing and loop until it is green again.

6. **Reuse audit (before any PR).** With tests green, run a dedicated reuse
   audit on the full change set: a focused pass (dispatch a subagent that
   greps/reads the repo), separate from the code review in step 5. For every
   new function, helper, component, type, or extraction the change
   introduces, search the repo for existing functionality that already
   covers it. Refactor every confirmed duplication to reuse the existing
   code; never ship a new invention when the repo already covers it. Re-run
   the full test suite and loop until it is green again. In a split, run
   this once on the full implementation, before slicing it into PRs.

7. **Ship at green.** When the full test suite passes, run the
   end-of-implementation steps in this order:
   - **Check PR size** against the **PR Size Limits** below
     (`git diff master...HEAD --stat`, ignoring generated files, lockfiles,
     and snapshots).
   - **If under the hard limit:** push the branch to origin
     (`git push -u origin HEAD`) and open a PR with `gh pr create` as a
     **non-draft** PR (so the daemon's review step can pick up review
     comments). **Always create a brand-new PR; never reopen a previously
     closed PR, even one referenced by the branch, commit, or ticket.** Title = the ticket summary; body = a short "what changed /
     why / test result", any **Decisions** you made to resolve uncertainty
     (with the alternative you rejected, and what was reused), and the
     ticket reference so the tracker auto-links the PR. Follow the repo's
     commit/PR conventions: never mention Claude, Claude Code, or AI, and
     add no "Generated with" or "Co-Authored-By" trailers.
   - **If over the hard limit:** follow the split flow described in **PR
     Size Limits** below instead of opening a single PR. The ticket branch
     itself never gets a PR in a split; only its slice branches do.
   - **Move the ticket to the Review column** in the kanban board (not Done,
     since Review signals the PR is ready for someone to review) once the
     PR, or in a split the whole series, is open.
   - **Spin up the local server on this session's tmux pane** so the change
     can be inspected running. In a split, run it from the ticket branch,
     since that branch is the one that keeps every change for whole-app
     local testing.
   Then STOP. Print a summary of what changed, the PR URL (or URLs, for a
   split), and the test result.

## Hard-Stop Rubric

The PR is the human checkpoint. Code that only takes effect once the PR is
merged or deployed (including **database migrations, schema changes,
authentication, and billing/payments logic**, even breaking ones) is **not** a
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
**not** a reason to stop, resolve it and keep going.

When unsure, **bias toward proceeding**: resolve the uncertainty with a
documented default and implement. Pause only when running the work itself would
irreversibly change real resources before the PR can be reviewed, never merely
because the change is sensitive, breaking, or you have a question.

## PR Size Limits

Keep PRs small enough to review. Measure the branch's changed lines against
`master`: `git diff master...HEAD --stat` (ignore generated files, lockfiles,
and snapshots).

- **Target: under 500 LOC.** Aim to land every PR under this.
- **Hard limit: ~1000 LOC.** A branch whose changes exceed ~1000 LOC **must**
  be split into multiple smaller PRs before shipping, no exceptions.

Implementation always happens as a whole, on the single ticket branch.
Splitting is a **PR-time operation**, not a set of separate implementation
branches: do all the work on the ticket branch, get it fully green (including
the reuse audit above), and only then decide how to slice it into PRs.

**The split flow, driven by `~/split-pr.sh`:**

- The **original ticket branch keeps every change and gets no PR of its
  own.** Leave it up as a local integration branch: it is the only place the
  whole app can be run and tested locally, end to end.
- Every PR is a **new, independent slice branch off `master`**, never a
  branch stacked on another slice and never a GitHub stacked PR. For each
  slice:
  1. Create the slice branch off `master`.
  2. Cherry-pick the subset of commits for that slice onto it.
  3. Push the slice branch.
  4. `gh pr create` as a **non-draft** PR (always a brand-new PR, never a
     reopened closed one), with a series marker `[i/n]` in the title and a
     body that lists every sibling slice branch/PR and its order in the
     series.
  5. Run `~/split-pr.sh <slice-branch> <i> <n>`.
- Repeat until the whole series is open, then move the ticket to the Review
  column once, not once per slice.

Prefer to catch large scope at **plan time**: if the plan clearly exceeds
~500 LOC, anticipate the split from the start. Even so, implement the whole
thing on the ticket branch first; only slice it into PRs once it is done and
green.
