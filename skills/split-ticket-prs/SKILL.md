---
name: split-ticket-prs
description: Use when pickup-ticket's finished, green ticket branch exceeds the 500 LOC hard limit, to slice it into independent subticket PRs off main, each in its own worktree and session.
---

# Split a ticket into PRs

The ticket branch is done and green; this slices it.

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
     mode exactly as in pickup-ticket's single-PR flow (always a brand-new PR,
     never a reopened closed one), with a series marker `[i/n]` in the title and a
     body that references the slice's subticket and lists every sibling slice
     branch/PR and its order in the series. Include the ticket's `UAT:`
     line, and open the PR as a draft if that line says `failed`.
     Add the `preview` label to a slice that changes runtime code, per the
     `ticket-uat` skill's preview label rule; skip test-only and docs-only slices,
     since the preview cap is small.
  6. Run `~/split-pr.sh <slice-branch> <i> <n>`. This gives the slice its own
     worktree **and its own tmux session** (named after the slice branch), with
     a linked Claude session. Never improvise the split yourself by opening
     tmux windows in the ticket's session or worktree; every slice lives in
     its own worktree + session, always via the script.
- Repeat until the whole series is open, then return to pickup-ticket's
  remaining step 7 bullets. Its Review move covers the ticket and every slice
  subticket.

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

## UAT in a split

- Local UAT already ran once on the full ticket branch. Put the
  same `UAT:` line (and screenshot) in every slice PR body.
- Add the `preview` label to runtime-code slices for humans, but run
  no preview walk-through on a slice: a slice preview lacks its siblings.
- If the `UAT:` line says `failed`, open every slice PR as a draft
  regardless of mode, and skip the Review moves for the ticket and every
  slice.
