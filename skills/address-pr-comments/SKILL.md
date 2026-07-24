---
name: address-pr-comments
description: Use when a yimbot review session opens on an existing PR branch to address every unresolved review comment, push, resolve the threads, and re-request review.
user-invocable: true
---

# Address PR Comments

Take an open pull request from "has unresolved review comments" to "comments
addressed, pushed, threads resolved, review re-requested, ready to test." The
worktree is already checked out on the PR's branch, and the seed prompt gave you
the PR number. This runs fully automatically; the one thing you never do is
falsely resolve a comment you did not actually address.

## Flow

1. **Confirm the PR and repo.** Read the PR number from the seed prompt. Get the
   repo slug with `gh repo view --json owner,name`. Sanity-check you are on the
   right branch with `gh pr view <number> --json number,headRefName,state` and
   `git branch --show-current`.

   This worktree is shared with the ticket session and the user may be running
   local dev in it, so **record the pre-existing state** with
   `git status --porcelain` before you touch anything. Those files are not yours
   to commit: never blanket-stage the tree (step 6).

2. **Fetch every unresolved review thread** (any author, humans and bots alike):

   ```bash
   gh api graphql -f query='
   query($owner:String!,$name:String!,$number:Int!){
     repository(owner:$owner,name:$name){
       pullRequest(number:$number){
         reviewThreads(first:100){ nodes {
           id isResolved isOutdated
           comments(first:30){ nodes { author{login} body path line diffHunk } }
         } }
       }
     }
   }' -f owner=OWNER -f name=NAME -F number=NUMBER
   ```

   Work only the threads where `isResolved` is false.

3. **Address each unresolved thread in code.** Understand what the comment asks,
   then make the change in the worktree. Check `IMPL_MODEL`
   (`echo "$IMPL_MODEL"`):
   - If set, dispatch the code changes to subagents on that model via
     `superpowers:subagent-driven-development`. Subagents do not inherit the
     global CLAUDE.md, so include this rule in every subagent prompt: never use
     em dashes (—) or en dashes (–) in any output, including thread replies,
     code comments, and commit messages.
   - If unset, implement in-session.
   Use `superpowers:test-driven-development` for anything that changes behavior.

   Keep a running record of which thread id maps to which change, **and the exact
   file paths you edit**; you will stage only those paths in step 6.

4. **Safety, never force.** If a thread needs a human decision (an open question,
   a disagreement, a request you cannot confidently satisfy), leave it
   **unresolved**, optionally reply on the thread explaining the situation, and
   note it in the final summary. Do not resolve a thread you did not address.

5. **Get tests green.** Run the project's test suite (or the affected tests) and
   loop until green. Do not push red.

6. **Commit and push** to the PR branch. Stage **only the paths you edited** (from
   step 3) by name, never `git add -A`, or you will sweep up the user's local-dev
   artifacts and unrelated changes from step 1 into your commit:

   ```bash
   git add path/to/file-a path/to/file-b   # only your edits
   git commit -m "address review comments"
   git push
   ```

   If the push is **rejected** (non-fast-forward: the branch advanced on the
   remote), rebase onto the remote and retry once:

   ```bash
   git pull --rebase origin "$(git branch --show-current)" && git push
   ```

   If the rebase hits a conflict or the push still fails, **stop**: run
   `git rebase --abort`, do NOT resolve any threads, leave the session open, and
   report in the summary that the branch diverged and needs a human. Do not force
   push.

7. **Resolve the threads you addressed**, one mutation per thread id from step 3:

   ```bash
   gh api graphql -f query='mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread { isResolved } } }' -f id=THREAD_ID
   ```

8. **Re-request review** from the human reviewers who had already reviewed or
   requested changes (skip bot accounts such as CodeRabbit / github-actions;
   those re-review automatically on the new push):

   ```bash
   gh pr edit <number> --add-reviewer LOGIN
   ```

9. **Flag the session ready to test** so the user knows they can run local dev
   here:

   ```bash
   tmux set-option -t "$(tmux display-message -p '#{session_name}')" @feature_status "#[fg=cyan]▶"
   ```

10. **Stop, stay open.** Do not close or kill this session. Print a summary: the
    threads addressed and resolved, any threads left unresolved and why, and the
    test result. Leaving the session open is what keeps yimbot from spawning a
    duplicate fix session for this PR, and lets the user run local dev to test.
