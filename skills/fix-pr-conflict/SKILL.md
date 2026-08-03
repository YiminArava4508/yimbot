---
name: fix-pr-conflict
description: Use when a yimbot review session opens on an existing PR branch that is conflicting with main, to resolve the conflict in a way that preserves the PR's feature, push, and get it mergeable again.
user-invocable: true
---

# Fix PR Merge Conflict

Take an open pull request from "conflicting with main" to "merged main in cleanly,
feature preserved, pushed, mergeable." The worktree is already checked out on the
PR's branch, and the seed prompt gave you the PR number. This runs fully
automatically.

The resolution is **semantic, not mechanical.** Before you touch a single
conflict, understand what the PR is trying to accomplish, then resolve each
conflict so that **both** main's incoming change and the PR's feature survive.
Never blindly take one side, never drop the PR's feature to make it merge, and
never revert main's change. If you cannot resolve confidently without risking the
feature, **bail cleanly** (step 5): abort the merge, push nothing, leave the PR
untouched.

You bring main in with a **merge**, never a rebase, and you **never force push** —
the PR's own commits stay intact; you only add a resolution merge commit.

## Flow

1. **Confirm the PR and repo.** Read the PR number from the seed prompt. Get the
   repo slug with `gh repo view --json owner,name`. Sanity-check you are on the
   right branch with `gh pr view <number> --json number,headRefName,mergeable,state`
   and `git branch --show-current`.

   This worktree is shared with the ticket session and the user may be running
   local dev in it, so **record the pre-existing state** with
   `git status --porcelain` before you touch anything. Those files are not yours
   to commit: never blanket-stage the tree (step 7).

2. **Understand the PR's intent.** This is the crux — you cannot resolve a
   conflict well without it. Read:

   ```bash
   gh pr view <number>          # title, description, linked ticket
   gh pr diff <number>          # exactly what this PR changes and why
   ```

   Read the linked ticket if there is one. Form a clear picture of the feature or
   fix this PR delivers and which of its changes are load-bearing.

3. **Bring main in with a merge.**

   ```bash
   git fetch origin main
   git merge origin/main
   ```

   If it merges clean, skip to step 6. Otherwise `git status` lists the conflicted
   paths — resolve them in step 4.

4. **Resolve each conflict, preserving the feature.** For every conflicted hunk,
   reconcile the two sides so main's incoming change and the PR's feature intent
   both hold. Read enough surrounding code to know what each side was doing;
   `git log` / `git blame` on the incoming side when the reason for main's change
   is not obvious. Do not blindly `--ours`/`--theirs`, do not delete the PR's
   feature to make the file merge, do not revert main.

   Migrations are a common conflict (two branches claiming the same number or
   touching generated code). For that mechanical part invoke the `merge-main`
   skill and follow it exactly — it handles renumbering, codegen, and migration
   regeneration.

5. **Bail cleanly if you cannot resolve safely.** If reconciling a conflict would
   risk compromising the PR's feature, or you genuinely cannot tell how to honor
   both sides, do not guess and do not push a best-effort merge:

   ```bash
   git merge --abort
   ```

   Restore the pre-existing worktree state, leave the session open, and report in
   your summary which conflict you could not resolve and why it needs a human.
   Stop here — do not continue to step 6.

6. **Verify.** Run the project's tests and typecheck for anything the merge
   touched (e.g. `pnpm test`, `pnpm typecheck`) and confirm they are genuinely
   green. Check `IMPL_MODEL` (`echo "$IMPL_MODEL"`): resolution decisions stay in
   this session (they need the PR-intent context from step 2), but if the merge
   requires a sizable code fix and `IMPL_MODEL` is set, dispatch that fix to
   subagents on that model via `superpowers:subagent-driven-development`.
   Subagents do not inherit the global CLAUDE.md, so include this rule in every
   subagent prompt: never use em dashes or en dashes in any output, including code
   comments and commit messages. Only continue once the resolution is confidently
   feature-preserving and the suite is green; if it is not, return to step 5 and
   bail.

7. **Commit and push** the merge. A merge commit records the resolution; complete
   it and push (fast-forward, no force):

   ```bash
   git commit --no-edit         # or a short "merge origin/main, resolve conflicts" message
   git push
   ```

   If you made additional code edits in step 6, stage **only the paths you
   edited** by name (never `git add -A`, or you sweep up the user's local-dev
   artifacts from step 1) and amend or add a follow-up commit before pushing.

   If the push is **rejected** (non-fast-forward: the branch advanced on the
   remote), rebase onto the remote and retry once:

   ```bash
   git pull --rebase origin "$(git branch --show-current)" && git push
   ```

   If the rebase hits a conflict or the push still fails, **stop**: run
   `git rebase --abort`, leave the session open, and report that the branch
   diverged and needs a human. Never force push.

8. **Flag the session ready to test** so the user knows they can run local dev
   here:

   ```bash
   tmux set-option -t "$(tmux display-message -p '#{session_name}')" @feature_status "#[fg=cyan]▶"
   ```

9. **Close the conflict-fix session (final step).** The resolution is pushed and
   the PR should now be mergeable. End this session so a later conflict can
   re-trigger a fresh fix (yimbot dedups by the PR head SHA, which your push has
   now moved, not by this session staying open). Print your summary first (what
   the PR does, which conflicts you resolved and how, the local test result), then
   as the very last action close the session. The PR number is in the seed prompt;
   your fix name is `pr-<number>-conflict`:
   - If this tmux session's own name equals `pr-<number>-conflict`, you are a
     standalone fix session, so kill it:
     ```bash
     tmux kill-session -t "=pr-<number>-conflict"
     ```
   - Otherwise you are a `pr-<number>-conflict` window inside the branch's ticket
     session, so kill just this window (leaving the ticket session and its
     ready-to-test flag intact):
     ```bash
     tmux kill-window -t "$(tmux display-message -p '#{session_name}'):pr-<number>-conflict"
     ```
   Only close on this success path. If you bailed at step 5, or the branch
   diverged at step 7, leave the session open as those steps say.
