---
name: self-improve-contract
description: Use when a yimbot self-improvement job skill (such as dead-code-scan) runs in a self-improve-* session, to apply the shared rules: narrow scope, prove or skip, verify, open one draft PR, then exit.
---

# Self-improvement contract

You are in a `self-improve-<job>` tmux session, in a worktree of the yimbot repo on a
`chore/self-improve-<job>-<date>` branch cut from `origin/master`. A job skill told
you what kind of change to make. These rules apply to every job.

1. **Narrow scope.** Make one kind of change, the one the job names. Do not fix
   unrelated things you notice. Do not touch `.env`, state files, or anything
   gitignored.
2. **Prove or skip.** Change only what the job's rule proves safe. Anything unsure
   is skipped, not changed. A skipped candidate costs nothing; a wrong change costs
   a review.
3. **Verify.** After the changes run `pnpm typecheck`, `pnpm test` and
   `pnpm test:sh`. All three must pass. When one fails, revert the change that
   caused it and run again. If you cannot tell which change broke it, revert
   everything and go to step 4 as "nothing changed".
4. **Ship.**
   - Nothing changed: remove nothing yourself, print `nothing to change`, then exit claude.
     The daemon deletes the worktree and branch.
   - Something changed: commit with a one-line message saying what and why (no
     em dashes, no mention of Claude or AI, no `Co-Authored-By`), then
     `git push -u origin HEAD` and open the PR with `gh pr create --draft`
     against `master`. Always a new PR, never reopen a closed one.
     Never mark it ready, never request review, never add the `ready-to-merge` label.
   - PR body: under 10 lines. What was removed or changed and the evidence for each.
5. **Hand off.** Print the PR URL, then exit claude. The daemon sees the PR,
   closes this session and removes the worktree. Do not clean up yourself.
