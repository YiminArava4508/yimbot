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
falsely resolve a comment you did not actually address. The other thing you
never do is bombard the PR with verbose, AI-generated explanations: thread
replies are capped tight (see steps 4 and 7), and anything the reviewer did not
literally ask about never goes on the PR at all.

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
   then make the change in the worktree, **in this session**. PR-fix work always
   runs on the stronger session model: never delegate it to cheaper
   implementation subagents, and ignore `IMPL_MODEL` even when it is set.
   Use `superpowers:test-driven-development` for anything that changes behavior.

   Keep a running record of which thread id maps to which change, **and the exact
   file paths you edit**; you will stage only those paths in step 6.

   As you work each thread, put it in one of the first two categories below;
   separately, collect anything in the third. Later steps act on the category:
   - **Fixed in code** - you fully satisfied the ask with a code change.
   - **Needs a human decision** - reserved for genuine disagreements, product
     or API decisions, and large risky changes, and only after you attempted a
     confident fix first. A **small** finding (localized, mechanical, low-risk:
     a typo, a rename, a guard clause, a small refactor, a missing test and the
     like) never lands here: always fix it yourself. Do not guess on the ones
     that do land here; do not half-fix them.
   - **Extra observation** (collected separately, not a per-thread bucket) -
     anything you notice that is beyond any thread's literal ask (a related
     bug, a risky pattern, a follow-up idea). Collect these; they never go on
     the PR.

4. **Threads that need a human decision.** Leave the thread **unresolved**. Post
   one short, honest reply on it stating that you have flagged it for a human to
   handle manually (one or two sentences, no attempt to resolve it, no
   reasoning dump). Note it for the summary and for the hand-back in step 9. Do
   not resolve a thread you did not address, and never force a guess into code.

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

7. **Resolve the threads you fixed in code.** If a reply genuinely helps, post
   at most one short line stating only what changed, e.g. `Fixed in <commit>`.
   No reasoning, no restating the comment, no extras; most threads need no reply
   at all beyond being resolved. Then resolve, one mutation per thread id from
   step 3:

   ```bash
   gh api graphql -f query='mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread { isResolved } } }' -f id=THREAD_ID
   ```

8. **Re-request review** from the human reviewers who had already reviewed or
   requested changes (skip bot accounts such as CodeRabbit / github-actions;
   those re-review automatically on the new push):

   ```bash
   gh pr edit <number> --add-reviewer LOGIN
   ```

9. **Hand back to the operator, or flag ready to test.** Source the launcher so
   the emitter is available: `source "$HOME/new-session.sh" 2>/dev/null`.
   - If any thread needs a human decision (step 4), set the stage and raise the
     board flag:
     ```bash
     emit_hook_event needs_decision
     emit_hook_event flagged
     ```
   - Else if you collected any extra observations (step 3) but every thread was
     fixed:
     ```bash
     emit_hook_event review_findings
     emit_hook_event flagged
     ```
   - Else (everything cleanly fixed, nothing to hand back) flag ready to test so
     the user knows they can run local dev here:
     ```bash
     tmux set-option -t "$(tmux display-message -p '#{session_name}')" @feature_status "#[fg=cyan]▶"
     ```
   Emit the status line **before** the `flagged` line: the board fold clears the
   flag on a status event and re-raises it on the trailing `flagged`, so the
   order is what makes STATUS and the flag both show.

10. **Close the fix session (final step), unless you handed it back.** If step 9
    took the ready-to-test branch (nothing flagged), everything is done: close
    the session so a later round of comments can re-trigger a fresh fix. Print
    your summary first (threads addressed and resolved, the test result), then
    as the very last action close the session. The PR number is in the seed
    prompt; your fix name is `pr-<number>-fix`:
    - If this tmux session's own name equals `pr-<number>-fix`, you are a
      standalone fix session, so kill it:
      ```bash
      tmux kill-session -t "=pr-<number>-fix"
      ```
    - Otherwise you are a `pr-<number>-fix` window inside the branch's ticket
      session, so kill just this window (leaving the ticket session and its
      ready-to-test flag intact):
      ```bash
      tmux kill-window -t "$(tmux display-message -p '#{session_name}'):pr-<number>-fix"
      ```
    Do **not** close when step 9 handed the task back (a `needs_decision` or
    `review_findings` flag). Instead print the summary as the session's final
    output: list each decision-needed thread and each extra observation in full,
    since the operator reads them here by pressing Enter on the flagged row,
    and leave the session open, exactly as you do when step 6 reports a diverged
    branch that needs a human.
