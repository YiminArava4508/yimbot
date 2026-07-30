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
   invoke the `merge-main` skill and follow it exactly — it handles the merge,
   codegen, and migration regeneration, then commits and pushes. That push moves
   the PR head, so the CI run restarts; if the sync alone makes it green, you are
   done — go to step 6. Do not loop back into another merge afterwards: once the
   branch is level with main, a still-red build is a code problem (step 4).

4. **Then fix the code.** If CI is failing for a real reason (or is still red
   after the sync), reproduce the failure locally, then fix it. Check `IMPL_MODEL`
   (`echo "$IMPL_MODEL"`):
   - If set, dispatch the code changes to subagents on that model via
     `superpowers:subagent-driven-development`. Subagents do not inherit the
     global CLAUDE.md, so include this rule in every subagent prompt: never use
     em dashes (—) or en dashes (–) in any output, including code comments and
     commit messages.
   - If unset, implement in-session.
   Use `superpowers:test-driven-development` for anything that changes behavior,
   and run the failing suite locally until it is genuinely green.

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

   (When step 3 ran `merge-main`, its own commit/push already happened; this step
   is for the code edits from step 4.)

   If the push is **rejected** (non-fast-forward: the branch advanced on the
   remote), rebase onto the remote and retry once:

   ```bash
   git pull --rebase origin "$(git branch --show-current)" && git push
   ```

   If the rebase hits a conflict or the push still fails, **stop**: run
   `git rebase --abort`, leave the session open, and report in the summary that
   the branch diverged and needs a human. Do not force push.

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
