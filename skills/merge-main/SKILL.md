---
name: merge-main
description: Use when a feature branch needs to be synced with main — typically before PR creation or when migrations may conflict with recently-merged work.
user-invocable: true
---

# Merge main

Bring the current branch level with `origin/main`: merge in the latest main,
regenerate any derived output, resolve conflicts honoring both sides, then commit
and push. This is the cheapest fix for a stale branch and the mechanical core of
resolving a conflicted PR. It runs automatically; the one thing you never do is
push a best-effort merge that guesses at a conflict you cannot confidently
resolve.

## Flow

1. **Confirm a clean starting point.** Record what was already dirty so you never
   sweep unrelated work into your merge commit:

   ```bash
   git status --porcelain   # note pre-existing changes; leave them alone
   git branch --show-current
   ```

   Only functional source should be committed before merging; local docs or plan
   files are fine to leave untracked.

2. **Prefer the project's own sync task, if it has one.** Many repos wrap the
   merge plus codegen and migration rebasing in a single command. If one exists,
   it is authoritative — use it instead of a bare `git merge`, because it also
   regenerates derived files a plain merge would leave stale:

   ```bash
   # examples — use whichever the repo actually defines:
   task merge-main            # Taskfile
   make merge-main            # Makefile
   pnpm merge-main            # package.json script
   ```

   If the project has no such task, do the merge yourself (step 3).

3. **Merge `origin/main`.**

   ```bash
   git fetch origin main
   git merge origin/main -m "Merge main"
   ```

   If it merges cleanly with no derived output to regenerate, skip to step 6.

4. **Regenerate derived output.** If the project generates code, schema, or
   migrations (ORM clients, GraphQL resolvers, protobuf, lockfiles, etc.), run
   its codegen now and rebase any branch-local migrations that landed out of
   order versus main. Regenerated files are easy to miss because they land
   unstaged — inspect the whole tree, not just the paths you touched.

5. **Resolve conflicts, preserving the feature.** First the shortcircuit: if the
   only conflicted path is an `atlas.sum`, it is a migration-checksum collision,
   not a real conflict — recalculate it and move on to step 6:

   ```bash
   atlas migrate hash --dir "file://<directory containing atlas.sum>"
   git add <path/to/atlas.sum>
   ```

   (If atlas.sum conflicts alongside other files, resolve those below, then still
   regenerate atlas.sum with `atlas migrate hash` rather than hand-merging it.)

   For each remaining conflicted hunk,
   reconcile both sides so main's incoming change and this branch's intent both
   hold. Read enough surrounding code (and `git log` / `git blame` the incoming
   side) to understand each change. Do not blindly `--ours` / `--theirs`, do not
   delete the feature to make a file merge, do not revert main. If you cannot
   resolve a conflict safely, stop:

   ```bash
   git merge --abort
   ```

   Leave the branch untouched and report that it needs a human.

6. **Commit everything and push.** Review the full working tree first, then stage
   only the merge result and regenerated output (never the pre-existing dirty
   files from step 1):

   ```bash
   git status                     # inspect EVERYTHING left unstaged
   git add <the merge + regenerated paths>
   git commit -m "chore: merge main and regenerate derived output"
   git push
   ```

   If the push is rejected as non-fast-forward, rebase onto the remote and retry
   once (`git pull --rebase origin "$(git branch --show-current)" && git push`);
   if that still fails, abort the rebase and report the divergence rather than
   force-pushing.

7. **Re-run tests if generated output changed.** If codegen or a migration
   produced different content, run the relevant suite to confirm the branch still
   works before handing back.
