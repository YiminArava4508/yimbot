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
whether/how ...") rather than code that ships, skip this flow entirely and
follow **Spike Tickets** below. Signals: a "spike" label, or a title/description
that asks a question or asks to investigate, research, or evaluate instead of
asking for a behavior change.

**Flag-archive check second.** If the ticket is an after-release "Archive
`<flag>` flag in prod" ticket (the `after-release` label plus that title), skip
this flow and follow **Flag Archive Tickets** below.

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
     and deletes the file. Record `UAT: passed` with `![uat](<asset-url>)`
     for the PR body. If the upload fails, record `UAT: passed (screenshot
     upload failed)` and `shred -u "$SHOT"`.
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
     step 6a forces `--draft` in either mode. **Always create a brand-new
     PR; never reopen a previously
     closed PR, even one referenced by the branch, commit, or ticket.** Title = the ticket summary; body = a short "what changed /
     why / test result", the `UAT:` line from step 6a, any **Decisions** you made to resolve uncertainty
     (with the alternative you rejected, and what was reused), and the
     ticket reference so the tracker auto-links the PR. Follow the repo's
     commit/PR conventions: never mention Claude, Claude Code, or AI, and
     add no "Generated with" or "Co-Authored-By" trailers.
   - **If over the hard limit:** follow the split flow described in **PR
     Size Limits** below instead of opening a single PR. The ticket branch
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
     and put these two lines in the description, since the checklist in **Flag
     Archive Tickets** reads them: `Flag key: <exact key>` and
     `PostHog flag ID: <id>` (prod project 117986, verified). Also list the
     checks still outstanding (experiments, surveys, dependent flags,
     scheduled changes, early-access features, replay link, external
     consumers) and the readback to record. Link the follow-up in the final
     summary and in a comment on the parent ticket. Use `Resolves <TICKET>` in
     the PR body. The after-release follow-up holds the remaining work, and the
     parent has to reach Done for the follow-up to unblock.
   - **Move the ticket to the Review column** in the kanban board (not Done,
     since Review signals the PR is ready for someone to review) once the
     PR, or in a split the whole series, is open. Skip this when UAT failed:
     the draft PR waits for a human.
   - **Spin up the local server on this session's tmux pane** so the change
     can be inspected running. In a split, run it from the ticket branch,
     since that branch is the one that keeps every change for whole-app
     local testing. When step 6a already started it, this no-ops.
   Then STOP. Print a summary of what changed, the PR URL (or URLs, for a
   split), and the test result.

## Spike Tickets

A spike's output is knowledge, not a PR. There is nothing to ship, so the PR,
review, split, and local-server steps above do not apply.

1. **Investigate** as cheaply as correctness allows. Any code you write is
   throwaway scaffolding: never open a PR for it.
2. **Leave no local-only work**, or the reaper will spare the worktree forever.
   Either discard the scaffolding (`git reset --hard` and
   `git clean -fd -e '.yimbot-*'` so yimbot's marker files survive), or if it
   is worth keeping for
   reference, commit and push the branch (`git push -u origin HEAD`, still no
   PR). The working tree must end clean with every commit on origin.
3. **Report findings on the ticket.** Post a comment with: the question, what
   you tried, the answer or recommendation, and suggested next steps (for
   example the follow-up ticket to write). Linear tickets (`eng-*`): write the
   markdown to a file and run `~/comment-ticket.sh <TICKET> - < findings.md`.
   Shortcut tickets (`sc-*`): use the Shortcut MCP.
4. **Move the ticket to the Review column.** Linear: run
   `~/move-ticket.sh <TICKET> "In Review"`. Shortcut: use the Shortcut MCP.
   Always Review, never Done: for Linear tickets the daemon checks the branch
   when the ticket enters review, and if it has no PR and no code it moves the
   ticket to Done itself and mentions the creator. Otherwise a human reads it
   there. The daemon then reaps this worktree and session, but only if step 2
   was honored. Shortcut tickets (`sc-*`) are not watched by the daemon: note
   in the findings summary that the session should be ended manually
   (`~/end-session.sh <branch>`).
5. **STOP.** Print the findings summary and where it was posted.

## Flag Archive Tickets

An after-release "Archive `<flag>` flag in prod" ticket may archive the flag
itself, but only through this checklist. There is no PR, review, split, or
local-server step. Read the exact flag key and PostHog flag ID from the ticket
description (`~/get-ticket.sh <TICKET>`) when it has `Flag key:` and `PostHog
flag ID:` lines; the ID must resolve to that key in prod project 117986. Older
tickets have no such lines: take the key from the backticked name in the title
("Archive `hubspot-call-list-sync` flag in prod"), search prod project 117986
for that exact key, and require exactly one flag with that key. Missing lines
alone never fail check 5. It fails only when the key can't be found or matches
more than one flag.

**Fail closed.** If any input can't be read (gh, git, Linear, PostHog), that
check fails. Never pass a check on missing data, and never skip one.

1. **Run the reference checks (checks 2 and 3).** `~/flag-archive-check.sh <key>`
   prints JSON (`pass`, `checks`, `builds`, `prodShas`, `docMatches`,
   `ignoredMatches`, `quietHours`) and exits non-zero on failure. It covers: no
   code references on `origin/main` of MatthewsREIS/gemini or anywhere else in
   the org, and none in the source folder of each gemini build prod runs (each
   app's chart and its local subcharts, at the commit their `appVersion` names;
   `builds` lists every app, chart, commit, and folder searched). `*.md` files
   are never searched in prod builds; on `origin/main` and the org they land in
   `docMatches` and don't fail. A code reference, in a non-test file, is the
   exact key as a quoted string (`"key"`, `'key'`, `` `key` ``), the key as a
   whole token in a config file (yaml, json, tf, `.env`, ...), or `.key` /
   `key:` in code. Every other match
   (the key inside a comment or a longer name such as a bucket or option, a test
   id, a mock, anything in a test file) lands in `ignoredMatches` and doesn't
   fail. The check is the gate: don't second-guess an ignored match, and don't
   override a failure because a hit "looks harmless"; raise needs-decision
   instead.
2. **Check 1, released.** The `Blocked by:` line of `~/get-ticket.sh <TICKET>`
   must list at least one blocker, and every blocker must be `Done`. The
   claim gate already checked this; re-check it anyway.
3. **Check 4, quiet in prod.** With the PostHog MCP, read the flag in project
   117986. `last_called_at` must be older than `quietHours` from step 1 (4
   unless `FLAG_ARCHIVE_QUIET_HOURS` is set). A null or missing `last_called_at`
   means the flag was never called: the check passes, and the readback says
   "never called". If the flag can't be read (PostHog error, flag not found),
   the check fails; that is not the same as never called.
4. **Check 5, nothing depends on it and archiving changes nothing for users.**
   In project 117986 all of these must hold:
   - no experiments, surveys, early-access features, or scheduled changes use
     the flag;
   - no other flag depends on it (search other flags' filters for this flag's
     ID);
   - session replay isn't linked to it;
   - the flag is active, at 100% rollout, with no release conditions.
   Product tours are out of scope (the PostHog key can't read them). Don't
   fail on them, but say so in the readback.

**If every check passes**, in this order:

a. **Save the flag's state** as a comment on the ticket before touching it: id,
   key, active, filters/rollout, `last_called_at`, enough to restore it.
b. **Archive the flag** with the PostHog MCP.
c. **Read it back** and confirm it now reads as archived. If it doesn't, raise
   needs-decision (below) with what you saw and stop.
d. **Post a readback comment** listing every check with its evidence, the prod
   commits searched (`prodShas`), any `docMatches`, any `ignoredMatches` (so a
   reviewer can audit what the check skipped), and the note that tours weren't
   checked.
e. **Move the ticket to In Review**, same as the spike flow: `~/move-ticket.sh
   <TICKET> "In Review"` (Shortcut: use the Shortcut MCP). No PR. Then STOP and
   print the readback.

**If any check fails**, archive nothing:

a. Run `~/needs-decision.sh "<failed check number and name>: <evidence>"` so
   the board stops showing the session as "working".
b. Post the same failed check and evidence as a comment on the ticket.
c. STOP.

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

**Exception: archiving a prod PostHog flag.** It is allowed without a "go",
only through the **Flag Archive Tickets** checklist, and only when every check
passes. Every other prod change still needs a "go".

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
  branch as one PR through the single-PR flow, skip the split flow below, and
  create no slices, subtickets, or `.yimbot-split-parent` flag. Unset or any
  other value means the limit applies as written.

Implementation always happens as a whole, on the single ticket branch.
Splitting is a **PR-time operation**, not a set of separate implementation
branches: do all the work on the ticket branch, get it fully green (including
the reuse audit above), and only then decide how to slice it into PRs.

**The split flow, driven by `~/split-pr.sh`:**

- **First, before anything else,** flag the ticket's own worktree as a split
  parent so cleanup never reaps it mid-split (this covers the window before the
  first slice exists, and the case where the ticket already has a PR you are
  about to close): `touch .yimbot-split-parent` from the ticket worktree root.
- The **original ticket branch keeps every change and gets no PR of its
  own.** Leave it up as a local integration branch: it is the only place the
  whole app can be run and tested locally, end to end.
- Every PR is a **new, independent slice branch off `main`**, never a
  branch stacked on another slice and never a GitHub stacked PR. Every slice
  also gets its **own subticket** under the original ticket, and its branch is
  named after that subticket, so each slice tracks and shows on the board as
  its own task. For each slice:
  1. Create the slice's subticket, titled `[i/n] <slice summary>`, with a
     points estimate sized to the slice. **Keep the parent's points:** read the
     parent's estimate before creating the first slice, and make the slice
     points add up to exactly that number, never more (the split redistributes
     the parent's points, it does not add to them). If the parent had no
     estimate, size the whole ticket as one unit first and use that as the
     total:
     - Linear tickets (`eng-*`): run
       `~/create-subticket.sh <TICKET> "[i/n] <slice summary>" <points> --claimable`.
       It creates the sub-issue in Todo and the current cycle, where intake
       lives (never Triage), carrying the parent's labels and zeroing the
       parent ticket's estimate so points live only on the slices. It prints
       two lines: the subticket identifier, then the slice branch name. Use
       that branch name verbatim in the next step. The daemon will not claim
       the slice out from under you: it skips Todo sub-issues whose parent is
       In Progress.
     - Shortcut tickets (`sc-*`): create a subtask under the story via the
       Shortcut MCP (`stories-create-subtask`), set the parent story's
       estimate to 0 (`stories-update`), and derive the slice branch from the
       subticket yourself: `<subticket-id>-<title-slug>`, lowercase,
       alphanumerics and dashes only, max 50 chars.
  2. Create the slice branch off `main`, named after the subticket as above
     (never after the parent ticket: the board keys rows by the ticket slug in
     the branch, so a parent-slug branch would collapse the slices into one
     row again).
  3. Cherry-pick the subset of commits for that slice onto it.
  4. Push the slice branch.
  5. `gh pr create`, draft in `supervised` mode / non-draft in `autonomous`
     mode exactly as in the single-PR flow above (always a brand-new PR,
     never a reopened closed one), with a series marker `[i/n]` in the title and a
     body that references the slice's subticket and lists every sibling slice
     branch/PR and its order in the series.
  6. Run `~/split-pr.sh <slice-branch> <i> <n>`. This gives the slice its own
     worktree **and its own tmux session** (named after the slice branch), with
     a linked Claude session. Never improvise the split yourself by opening
     tmux windows in the ticket's session or worktree; every slice lives in
     its own worktree + session, always via the script.
- Repeat until the whole series is open, then move the ticket **and every
  slice subticket** to the Review column, once each.

**If a slice did end up stacked on a sibling** (a PR based on another slice's
branch rather than `main`), it gets no real CI: the CI workflow only triggers on
PRs whose base matches, so the stack sits on `pr-size` alone. Reroot it onto
`main`, but do the move **in place, on the ticket branch**:

```bash
git switch <ticket-branch>
git branch backup/<ticket>-pre-reroot HEAD
git rebase --onto main <sibling-branch>
```

Never build the rerooted history on a temp branch to move back afterwards. That
is two steps, and if the second is denied or the session ends between them, the
worktree is stranded on a branch carrying no ticket slug, which breaks the
board's row and its session jump. If any git command in the sequence is denied,
**stop and hand the remaining commands to the human** rather than improvising a
workaround that leaves history half-moved. Only reroot when the slice's own
commits do not use the sibling's code: check the diff first, build the affected
modules after.

Prefer to catch large scope at **plan time**: if the plan clearly exceeds
~500 LOC, anticipate the split from the start. Even so, implement the whole
thing on the ticket branch first; only slice it into PRs once it is done and
green.
