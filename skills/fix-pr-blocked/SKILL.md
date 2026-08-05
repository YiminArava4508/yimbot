---
name: fix-pr-blocked
description: Use when a yimbot review session opens on an existing PR branch that the merge queue (Aviator) blocked after its combined-CI batch failed, to investigate the failure, fix this PR if it is at fault, then unblock and re-queue it.
user-invocable: true
---

# Fix PR Blocked by the Merge Queue

Take a pull request the merge queue kicked out (it carries the `blocked` label and
lost `ready-to-merge`) back to "unblocked and re-queued." The worktree is already
checked out on the PR's branch, and the seed prompt gave you the PR number. This
runs fully automatically. Never fake a green build: never disable, skip, or delete
a check or test to make it pass. If you cannot legitimately unblock it, leave the
`blocked` label on, push nothing, and report why.

The failure did not happen on this PR's own head. The queue merges your PR together
with the PRs ahead of it into a combined draft PR and runs CI on that. So the cause
is often not your PR at all, it is another PR in the batch or a flake. Investigate
before you touch any code.

## Flow

1. **Confirm the PR and repo.** Read the PR number from the seed prompt. Get the
   slug with `gh repo view --json owner,name`. Sanity-check the branch and state
   with `gh pr view <number> --json number,headRefName,state` and
   `git branch --show-current`. This worktree is shared with the ticket session and
   the user may be running local dev in it, so record the pre-existing state with
   `git status --porcelain` before you touch anything. Never blanket-stage the tree.

2. **Read the Aviator block.** Read the queue's comment to learn what failed and
   where:

   ```bash
   gh pr view <number> --comments
   ```

   Find the most recent "This pull request failed to merge" comment. Note the
   "Failed checks:" list and the "Associated Draft PR #<n>" number. If there is no
   such comment (a stray `blocked` label with no queue failure), stop: leave the
   label alone and report that there is nothing to unblock. Do not proceed to flag
   ready-to-test or close the session, just report and stop.

3. **Investigate the combined failure.** Read the associated draft PR's failing
   logs:

   ```bash
   gh pr checks <draft-number>
   gh run view --log-failed   # or: gh run view <run-id> --log-failed
   ```

   Decide whether the failure is caused by this PR's changes or by another PR in
   the batch (or a flake). Read enough of the failure to be sure.

4. **Fix if this PR is at fault.** Reproduce the failure locally, then fix it.
   Check `IMPL_MODEL` (`echo "$IMPL_MODEL"`):
   - If set, dispatch the code changes to subagents on that model via
     `superpowers:subagent-driven-development`. Subagents do not inherit the global
     CLAUDE.md, so include this rule in every subagent prompt: never use em dashes
     or en dashes in any output, including code comments and commit messages.
   - If unset, implement in-session.
   Use `superpowers:test-driven-development` for anything that changes behavior, and
   run the failing suite locally until it is genuinely green. Keep a running record
   of the exact file paths you edit; you stage only those in step 5.

5. **Commit and push** to the PR branch, staging only the paths you edited by name,
   never `git add -A`:

   ```bash
   git add path/to/file-a path/to/file-b
   git commit -m "fix combined-CI failure"
   git push
   ```

   If the push is rejected (non-fast-forward), rebase onto the remote and retry
   once: `git pull --rebase origin "$(git branch --show-current)" && git push`. If
   the rebase conflicts or the push still fails, run `git rebase --abort`, leave the
   session open, and report that the branch diverged and needs a human.

6. **Unblock and re-queue.** This is the required final action on the success path,
   whether or not step 4 pushed anything (a transient or other-PR failure is
   unblocked with no code change, as a single retry):

   ```bash
   gh pr edit <number> --remove-label "blocked" --add-label "ready-to-merge"
   ```

   `blocked` and `ready-to-merge` are the daemon's DEFAULT label names
   (`BLOCKED_LABEL` and `READY_MERGE_LABEL`). If those env vars have been
   customized in the daemon config, use those exact names here instead: remove
   the block label this PR actually carries, and add the queue's ready label.

7. **Bail cleanly when uncertain.** If you cannot determine the cause, or a fix
   would be risky, or you could not make the build green: leave the `blocked` label
   on, push nothing, leave the session open, and report why. Never re-queue a PR you
   believe is genuinely broken. yimbot dedups by the blocked head SHA, so it will
   not immediately retry; a human takes it from here.

8. **Flag ready to test** so the user knows they can run local dev here:

   ```bash
   tmux set-option -t "$(tmux display-message -p '#{session_name}')" @feature_status "#[fg=cyan]▶"
   ```

9. **Close the session (final step, success path only).** Print your summary first
   (what failed, whose fault it was, whether you fixed code or just re-queued, the
   local test result), then close the session. Your fix name is
   `pr-<number>-blocked`:
   - If this session's own name equals `pr-<number>-blocked`, kill it:
     ```bash
     tmux kill-session -t "=pr-<number>-blocked"
     ```
   - Otherwise kill just this window inside the ticket session:
     ```bash
     tmux kill-window -t "$(tmux display-message -p '#{session_name}'):pr-<number>-blocked"
     ```
   Only close on the success path. If you bailed at step 2, step 5, or step 7, leave the
   session open.
