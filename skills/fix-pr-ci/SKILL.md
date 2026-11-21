---
name: fix-pr-ci
description: Use when a yimbot review session opens on an existing PR branch whose CI has failed, to get the build green (sync with main when stale, fix code otherwise), push, and re-request the run.
user-invocable: true
---

# Fix PR CI

Take an open pull request from "CI failing" to "build green, pushed, ready to
test." The worktree is already checked out on the PR's branch, and the seed
prompt gave you the PR number. This runs fully automatically. The one thing you
never do is fake a green build: never disable, skip, or delete a failing check or
test to make it pass. If you cannot legitimately make it green, leave the session
open and report why.

A very common cause is not a code defect at all: the branch is behind
`origin/main` and just needs syncing. Try that first — it is the cheapest fix.

## Flow

1. **Confirm the PR and repo.** Read the PR number from the seed prompt. Get the
   repo slug with `gh repo view --json owner,name`. Sanity-check you are on the
   right branch with `gh pr view <number> --json number,headRefName,state` and
   `git branch --show-current`.

   This worktree is shared with the ticket session and the user may be running
   local dev in it, so **record the pre-existing state** with
   `git status --porcelain` before you touch anything. Those files are not yours
   to commit: never blanket-stage the tree (step 5).

2. **See what is failing.** List the checks and read the failing logs:

   ```bash
   gh pr checks <number>
   gh run view --log-failed   # or: gh run view <run-id> --log-failed
   ```

   Read enough of the failure to know whether it is a stale-branch problem
   (conflicts with main, a required "branch up to date" check, or a failure in
   code you did not touch) or a genuine defect in this branch's changes.

3. **Stale-branch first.** If the branch is behind `origin/main`
   (`git fetch origin main` then check `git rev-list --count HEAD..origin/main`),
   merge it in directly, after fast-forwarding to the remote branch so the later
   push is not rejected:

   ```bash
   git fetch origin "$(git branch --show-current)"
   git merge --ff-only "origin/$(git branch --show-current)"
   git merge origin/main
   ```

   If the `--ff-only` merge refuses, the branch has diverged: a bot (e.g. an
   automated "merge main" workflow) or another session pushed while this worktree
   held unpushed commits. That is routine, not a reason to stop. Merge the remote
   branch in, never rebase, never `git reset --hard`, never force push:

   ```bash
   git merge --no-edit "origin/$(git branch --show-current)"
   ```

   then carry on with the `origin/main` merge. Resolve the remote merge's conflicts
   the same way as main's (next paragraph). A diverged branch often carries the
   same migration under two numbers (one side renumbered it, the other did not):
   keep the copy that sorts after main's latest, `git rm` the other, and rehash
   `atlas.sum`. Stop only when a conflict in hand-written code cannot be reconciled
   safely (see "Stopping for a human" below).

   Do not run the project's full sync task (`task merge-main` or similar): its
   codegen output is gitignored, so it produces nothing committable and can eat
   the whole session. Resolve any conflicts the way the `fix-pr-conflict` skill
   does: an `atlas.sum`-only conflict is just `atlas migrate hash` + stage, and
   whenever `atlas.sum` collided, also check migration ordering first: any
   branch-new migration sorting before main's latest gets renumbered with the
   project's rebase task (e.g. `task atlas-auto-rebase`) or
   `atlas migrate rebase` before rehashing. Commit the merge
   and push. That push moves the PR head, so the CI run restarts; if the sync
   alone makes it green, you are done — go to step 6. Do not loop back into
   another merge afterwards: once the branch is level with main, a still-red
   build is a code problem (step 4).

4. **Then fix the code.** If CI is failing for a real reason (or is still red
   after the sync), reproduce the failure locally, then fix it **in this
   session**. One special case: if the failing check is a codegen-freshness
   check (committed generated files out of date), run the specific codegen
   command that check names and commit only the tracked output it regenerates. PR-fix work always runs on the stronger session model: never
   delegate it to cheaper implementation subagents, and ignore `IMPL_MODEL`
   even when it is set.
   Use `superpowers:test-driven-development` for anything that changes behavior,
   and run the failing suite locally until it is genuinely green.

   Never post a PR comment describing the fix: this work is not a response to
   any review comment, so the commit and your session summary are the record.

   Keep a running record of **the exact file paths you edit**; you stage only
   those paths in step 5.

5. **Commit and push** to the PR branch. Stage **only the paths you edited** by
   name, never `git add -A`, or you will sweep up the user's local-dev artifacts
   and unrelated changes from step 1 into your commit:

   ```bash
   git add path/to/file-a path/to/file-b   # only your edits
   git commit -m "fix failing CI"
   git push
   ```

   (When step 3 merged main, its merge commit and push already happened; this
   step is for the code edits from step 4.)

   If the push is **rejected** (non-fast-forward: the branch advanced on the
   remote), merge the remote branch in and retry once. Never `git pull --rebase`
   here: a rebase flattens the main merge and replays main's commits onto the
   branch as duplicates, muddying the PR history.

   ```bash
   git pull --no-rebase --no-edit origin "$(git branch --show-current)" && git push
   ```

   If that merge conflicts, resolve it like any other: an `atlas.sum` or
   migration-numbering conflict is mechanical (renumber or drop the duplicate
   migration, rehash, stage), then commit and push. Only if a conflict in
   hand-written code cannot be reconciled safely, or the push still fails, stop:
   `git merge --abort`, follow "Stopping for a human" below, and leave the session
   open. Never force push.

6. **Flag the session ready to test** so the user knows they can run local dev
   here:

   ```bash
   tmux set-option -t "$(tmux display-message -p '#{session_name}')" @feature_status "#[fg=cyan]▶"
   ```

7. **Close the CI-fix session (final step).** Everything above is done: the fix
   is pushed and the build should re-run green. Now end this session so a later
   failing run can re-trigger a fresh fix (yimbot dedups by the failing head SHA,
   which your push has now moved, not by this session staying open). Print your
   summary first (what was failing, whether it was a stale-branch sync or a code
   fix, the local test result), then as the very last action close the session.
   The PR number is in the seed prompt; your fix name is `pr-<number>-ci`:
   - If this tmux session's own name equals `pr-<number>-ci`, you are a standalone
     fix session, so kill it:
     ```bash
     tmux kill-session -t "=pr-<number>-ci"
     ```
   - Otherwise you are a `pr-<number>-ci` window inside the branch's ticket
     session, so kill just this window (leaving the ticket session and its
     ready-to-test flag intact):
     ```bash
     tmux kill-window -t "$(tmux display-message -p '#{session_name}'):pr-<number>-ci"
     ```
   Only close on this success path. If you stopped at step 5 because the branch
   diverged, or you could not legitimately make the build green, leave the session
   open as those steps say.

## Stopping for a human

Every path above that ends with "stop" or "needs a human" also raises it on the
board, so the row shows "needs decision" instead of still looking busy, and
whoever is watching knows to look:

```bash
~/needs-decision.sh "PR #<number>: <one-line reason, e.g. conflict in api/foo.go needs a product call>"
```

Then print your summary and leave the session open. Do not stop for anything a
rule above tells you how to resolve (a diverged remote, an `atlas.sum` or
migration-numbering conflict): those are routine.
