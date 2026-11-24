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

**Spike check first.** If the ticket is a spike, meaning its deliverable is an
answer or recommendation (feasibility, investigation, comparison, "figure out
whether/how ...") rather than code that ships, skip this flow entirely:
invoke the `spike-ticket` skill now and follow it instead. Signals: a "spike" label, or a title/description
that asks a question or asks to investigate, research, or evaluate instead of
asking for a behavior change.

**Flag-archive check second.** If the ticket is an after-release "Archive
`<flag>` flag in prod" ticket (the `after-release` label plus that title), skip
this flow: invoke the `archive-flag-ticket` skill now and follow it instead.

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

   - **Sizing notes are estimation context, not a plan.** A "Sizing",
     "Justification", or similar estimation section in the ticket may point you
     at related tickets or code to read, but never take the approach, mechanism,
     or type from it. Derive the approach from the problem statement,
     acceptance criteria, comments, and the codebase. If the note's suggestion
     and an existing pattern disagree, follow the existing pattern and record
     the choice under Decisions.
   - **Look up the existing UI pattern.** When the ticket asks for user-facing
     behavior (a filter, input, column, form field), find a feature in the repo
     that already behaves the way the ticket asks, or the one a reviewer would
     compare it to, and copy its configuration and component. Name that
     reference feature in the plan's Decisions note. Only build new behavior
     when no existing feature does the same thing.
   - **Look up the default path.** For that same behavior, trace what a user
     gets without changing any setting: the default operator, predicate, mode,
     or variant the UI selects when the feature first renders. Plan for the
     requested behavior to work on that default path, the same way it does on
     the reference feature. Behavior that only appears after the user picks a
     non-default option does not meet the ticket.

1a. **Size check.** Size the plan on the 1, 2, 3, 5, 8, 13, 21 scale. Skip this step
   when the ticket has no estimate or a 0 estimate. For `eng-*` tickets, write
   the reason to a file (the estimate, your planned size, and the evidence: files
   touched, rough changed LOC) and run
   `~/reject-ticket.sh <TICKET> <planned-points> - < reason.md`. Exit 0 means
   the ticket was rejected (comment posted, `rejected` label added, ticket moved back to Todo): print one
   line saying so and **STOP**, write no code. Exit 3 means the plan is within
   tolerance: continue. Any other exit (1, 127 for a missing script, a network
   error) means the check itself failed: print the error and **STOP**, do not
   implement a ticket whose size check did not complete. For `sc-*` tickets, when your planned size is 2 or more
   steps above the estimate, post the reason with `stories-create-comment`, add
   the `rejected` label with `stories-update`, and STOP. Never change the
   estimate yourself.

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

   For user-facing behavior, the first failing test covers the default path
   found in step 1: render or build the feature with its default settings
   (no operator, predicate, or mode chosen by the test), feed it the input the
   ticket describes, and assert the requested result. Tests that only set a
   non-default option do not count toward this.

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

6a. **Local UAT (before any PR).** Use the feature in the running app the way
   a user would, before a reviewer does.
   - **When it runs:** the change touches user-facing UI in a repo with
     Playwright set up (gemini's `react-ui/tests`). Backend-only changes and
     repos without Playwright skip it; record `UAT: skipped (<reason>)` for
     the PR body and go to step 7.
   - **Start the env:** from the worktree root, set `WT=$(git rev-parse
     --show-toplevel)`, run `~/run-local-env.sh "$(basename "$WT")"`, then
     `BASE_URL=$(~/wait-local-env.sh "$WT")`. If the wait exits non-zero,
     retry once with `~/run-local-env.sh --force "$(basename "$WT")"` and wait
     again. If that also fails, skip UAT with the error as the reason.
   - **Write the spec** at `react-ui/tests/<ticket-slug>.spec.ts`, following
     `react-ui/tests/AGENTS.md`. It creates the data it needs, opens the
     feature with its default settings (the test picks no operator,
     predicate, or mode), enters the input the ticket describes, and asserts
     the acceptance criteria. At the passing state it calls
     `page.screenshot({ path: process.env.UAT_SCREENSHOT })`. Admin-only
     screens use gemini's `admin-session-stub` skill. This spec is the
     default-path test from step 4 when step 4 did not already write one in
     Playwright. It ships in the PR and counts toward the PR Size Limits.
   - **Run it** from `react-ui`: `SHOT=$(mktemp --suffix=.png)`, then
     `PLAYWRIGHT_BASE_URL=$BASE_URL UAT_SCREENSHOT=$SHOT npx playwright test
     tests/<ticket-slug>.spec.ts`.
   - **On failure:** fix the code (not the spec, unless the spec misreads the
     ticket), re-run the full test suite, and re-run the spec. After 3 failed
     rounds, stop fixing: record `UAT: failed` with the last failure output
     for the PR body and go to step 7, which then opens a draft and leaves the
     ticket out of Review.
   - **On pass:** run `~/attach-ticket.sh "$SHOT"`; it prints the asset URL
     and deletes the file. Record `UAT: passed (local)` with
     `![uat](<asset-url>)` for the PR body. If the upload fails, record
     `UAT: passed (local, screenshot upload failed)` and `shred -u "$SHOT"`.
   - Leave the env running.

7. **Ship at green.** When the full test suite passes, run the
   end-of-implementation steps in this order:
   - **Check PR size** against the **PR Size Limits** below
     (`git diff main...HEAD --stat`, ignoring generated files, lockfiles,
     and snapshots).
   - **If under the hard limit:** push the branch to origin
     (`git push -u origin HEAD`) and open a PR with `gh pr create`.
     **Check the operating mode first**: read
     `"$(dirname "$EVENTS_LOG")/mode"` (if `EVENTS_LOG` is unset or the
     file is missing, treat it as `supervised`). In `supervised` mode pass
     `--draft` (a human marks the PR ready for review); in `autonomous`
     mode open it non-draft. The daemon's review and ready steps process
     drafts too, so this only gates the merge. A `UAT: failed` result from
     step 6a forces `--draft` in either mode, and a failed step 7b converts the
     PR back to draft (`gh pr ready --undo`). **Always create a brand-new
     PR; never reopen a previously
     closed PR, even one referenced by the branch, commit, or ticket.** Title = the ticket summary; body = a short "what changed /
     why / test result", the `UAT:` line from step 6a, any **Decisions** you made to resolve uncertainty
     (with the alternative you rejected, and what was reused), and the
     ticket reference so the tracker auto-links the PR. Follow the repo's
     commit/PR conventions: never mention Claude, Claude Code, or AI, and
     add no "Generated with" or "Co-Authored-By" trailers.
   - **Preview environment (gemini PRs only).** Right after `gh pr create`
     on a gemini branch, run `gh pr edit <pr> --add-label preview`. A bot then
     builds a seeded environment at `https://pr-<n>-portal.devmk8s.com` and
     comments the live URL on the PR (see gemini
     `docs/runbooks/feature-environments.md`, "Preview a PR"). Skip it for a
     docs-only or test-only PR, and for a PR from a fork or another repo. The
     label is best-effort: if it is refused (capacity, branch behind `main`),
     the bot removes it and says why in its comment; note that in the summary
     and carry on, never retry in a loop and never block the ticket on it.
     Previews are torn down after 7 days without a push.
   - **7b. Preview walk-through (gemini UI changes, after the `preview`
     label).** Once the PR is open and labeled `preview`, wait for the
     `preview-live` label (`gh pr view <pr> --json labels`, check every 60s,
     give up after 25 minutes). The URL is
     `https://pr-<n>-portal.devmk8s.com`. Live means the images built, so the
     first page load may fail for a few minutes while Argo rolls out; retry it.
     Then walk the feature in the user's signed-in Chrome (its Okta session
     signs in on its own):
     1. Call `mcp__claude-in-chrome__tabs_context_mcp`, then
        `mcp__claude-in-chrome__tabs_create_mcp`, and navigate the new tab to
        the preview URL. Work only in tabs you created.
     2. If a sign-in page appears, do not type any credentials: close your
        tabs, record `Preview: not walked (Chrome not signed in)`, and carry on.
     3. Navigate to each changed screen and do what the ticket's acceptance
        criteria describe. For each state worth showing, take a screenshot
        with the `computer` tool (`action: "screenshot", save_to_disk: true`)
        and immediately run `~/attach-ticket.sh <saved-path>`. It prints the
        asset URL and deletes the file. If it exits non-zero, run
        `shred -u <saved-path>` and continue without that image. Confirm the
        file is gone with `test ! -e <saved-path>`; if not, `shred -u` it.
        Never copy a screenshot anywhere else.
     4. Close your tabs with `mcp__claude-in-chrome__tabs_close_mcp`.
     5. Post one PR comment (`gh pr comment <pr> --body-file`; on a rerun use
        `--edit-last`) with the preview URL, a line per acceptance criterion
        saying what you did and what you saw, and the `![](<asset-url>)`
        images.
     - **If a criterion visibly fails:** fix the code, re-run the full test
       suite, push, wait for the new build to go live, and walk it again.
       After 3 failed rounds record `UAT: failed` with what you saw in the PR
       body and convert the PR to draft (`gh pr ready --undo`).
     - **If the label is refused or removed, or the preview is not live in
       time:** skip the walk-through, say why in the PR body, and carry on.
       Never block the ticket on the preview.
   - **If over the hard limit:** invoke the `split-ticket-prs` skill now and
     follow it instead of opening a single PR; come back here for the
     remaining bullets once the whole series is open. The ticket branch
     itself never gets a PR in a split; only its slice branches do.
   - **If the change lands in another repo** (a terraform repo, say), branch
     there under the same name as this worktree's branch and open the PR from
     that checkout (`gh pr create` in that directory). The board links a PR to
     this session by the ticket slug in its branch name, so a differently
     named branch leaves the row without a PR.
   - **Defer post-release work.** If the ticket asks for work that can only
     happen after the change ships (for example "after it deploys", "after
     release", archiving a flag in prod), do NOT do that work. Before moving the
     ticket to Review, run
     `~/create-subticket.sh <TICKET> "<follow-up title>" <points> --after-release`.
     For a flag archive, title it exactly "Archive `<flag-key>` flag in prod"
     and put these two lines in the description, since the `archive-flag-ticket`
     skill reads them: `Flag key: <exact key>` and
     `PostHog flag ID: <id>` (prod project 117986, verified). Also list the
     checks still outstanding (experiments, surveys, dependent flags,
     scheduled changes, early-access features, replay link, external
     consumers) and the readback to record. Link the follow-up in the final
     summary and in a comment on the parent ticket. Use `Resolves <TICKET>` in
     the PR body. The after-release follow-up holds the remaining work, and the
     parent has to reach Done for the follow-up to unblock.
   - **Move the ticket to the Review column** in the kanban board (not Done,
     since Review signals the PR is ready for someone to review) once the
     PR, or in a split the whole series, is open. Skip this when UAT failed
     (step 6a or 7b): the draft PR waits for a human.
   - **Spin up the local server on this session's tmux pane** so the change
     can be inspected running. In a split, run it from the ticket branch,
     since that branch is the one that keeps every change for whole-app
     local testing. When step 6a already started it, this no-ops.
   Then STOP. Print a summary of what changed, the PR URL (or URLs, for a
   split), the preview URL when one was requested, and the test result.

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

**Exception:** the only prod change allowed without a go is archiving a PostHog
flag through the `archive-flag-ticket` skill.

Nothing else pauses. Writing migration, auth, or billing code, touching many
files, touching shared or core code, or the plan containing an open question is
**not** a reason to stop, resolve it and keep going.

When unsure, **bias toward proceeding**: resolve the uncertainty with a
documented default and implement. Pause only when running the work itself would
irreversibly change real resources before the PR can be reviewed, never merely
because the change is sensitive, breaking, or you have a question.

## PR Size Limits

Keep PRs small enough to review. Measure the branch's changed lines against
`main`: `git diff main...HEAD --stat` (ignore generated files, lockfiles,
and snapshots).

- **Target: well under 500 LOC.** Aim to land every PR comfortably below the limit.
- **Hard limit: 500 LOC.** A branch whose changes exceed 500 LOC **must**
  be split into multiple smaller PRs before shipping, no exceptions.
- **Exception: `echo "$SPLIT_TICKETS"` is `false`, `off`, `0`, or `no`.**
  Splitting is disabled: never split, whatever the size. Ship the ticket
  branch as one PR through the single-PR flow, skip the split flow, and
  create no slices, subtickets, or `.yimbot-split-parent` flag. Unset or any
  other value means the limit applies as written.

Implementation always happens as a whole, on the single ticket branch.
Splitting is a **PR-time operation**, not a set of separate implementation
branches: do all the work on the ticket branch, get it fully green (including
the reuse audit above), and only then decide how to slice it into PRs.

Over the hard limit, the split flow lives in the `split-ticket-prs` skill.

Prefer to catch large scope at **plan time**: if the plan clearly exceeds
~500 LOC, anticipate the split from the start. Even so, implement the whole
thing on the ticket branch first; only slice it into PRs once it is done and
green.
