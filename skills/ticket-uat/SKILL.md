---
name: ticket-uat
description: Use when pickup-ticket reaches local UAT (before any PR) or has just opened a gemini PR, to use the feature in the running app, screenshot it, and record the UAT result for the PR.
---

# Ticket UAT

Use the feature in the running app the way a user would, before a reviewer
does. pickup-ticket invokes this twice: the local phase before any PR (the
gate), and the preview phase right after `gh pr create`.

Shell variables do not survive between Bash tool calls. Every command below
uses literal paths and values; read a printed value from the output and type
it into the next command.

## Local phase

- **When it runs:** the change touches user-facing UI in a repo with
  Playwright set up (gemini's `react-ui/tests`). Backend-only changes and
  repos without Playwright skip it; record `UAT: skipped (<reason>)` for the
  PR body and return to pickup-ticket. In a split, run it once on the full
  ticket branch before slicing; `split-ticket-prs` carries the result to
  every slice.
- **Credentials:** `react-ui/.env.local` must define `PLAYWRIGHT_USERNAME`
  and `PLAYWRIGHT_PASSWORD` (check with
  `grep -q '^PLAYWRIGHT_USERNAME=' react-ui/.env.local`). A missing file or
  key records `UAT: skipped (no Playwright credentials in react-ui/.env.local)`.
- **Start the env:** run `~/run-local-env.sh <worktree-dir-name>` with the
  worktree directory's literal name, then
  `~/wait-local-env.sh <absolute-worktree-path> 540` with the Bash tool's
  `timeout: 600000`, so the script times out (exit 2) before the tool does. It prints
  the React URL. Retry once with `~/run-local-env.sh --force
  <worktree-dir-name>` and wait again only when the wait exits 2 (timed out).
  Exit 1 means no `.env.worktree` or ports: skip UAT with that as the reason.
  If the retry also fails, skip UAT with the error as the reason.
- **Write the spec** at `react-ui/tests/<ticket-slug>.spec.ts`, following
  `react-ui/tests/AGENTS.md`. It creates the data it needs, opens the feature
  with its default settings (the test picks no operator, predicate, or mode),
  enters the input the ticket describes, and asserts the acceptance criteria.
  At the passing state it calls
  `page.screenshot({ path: process.env.UAT_SCREENSHOT })`. Admin-only screens
  use gemini's `admin-session-stub` skill. This spec is the default-path test
  from pickup-ticket step 4 when step 4 did not already write one in
  Playwright. It ships in the PR and counts toward the PR Size Limits.
- **Run it** in one Bash call from `react-ui`:
  `mkdir -p ~/.cache/yimbot/uat && set -a && . ./.env.local && set +a &&
  PLAYWRIGHT_BASE_URL=<url> UAT_SCREENSHOT=$HOME/.cache/yimbot/uat/<ticket-slug>.png
  pnpm test:playwright tests/<ticket-slug>.spec.ts`. The `pnpm` form goes
  through the heavy-job queue.
- **Login failure:** if the `setup` project (auth) fails, treat it as an
  env skip, not a code problem: record
  `UAT: skipped (local login failed: <first error line>)` and spend no
  code-fix round on it.
- **On failure:** fix the code (not the spec, unless the spec misreads the
  ticket), re-run the full test suite, and re-run the spec. After 3 failed
  rounds, stop fixing: record `UAT: failed` with the last failure output for
  the PR body. pickup-ticket then opens a draft and leaves the ticket out of
  Review.
- **On pass:** run `~/attach-ticket.sh ~/.cache/yimbot/uat/<ticket-slug>.png`;
  it prints the asset URL and deletes the file. Record `UAT: passed (local)`
  with `![uat](<asset-url>)` for the PR body. If the upload fails, record
  `UAT: passed (local, screenshot upload failed)` and run
  `rm -f ~/.cache/yimbot/uat/<ticket-slug>.png`.
- Leave the env running.

## Preview phase

The preview walk-through runs only for single-PR tickets. In a split, slices
follow the label rules in `split-ticket-prs` and get no walk-through.

- **Preview environment (gemini PRs only).** Right after `gh pr create`
  on a gemini branch, run `gh pr edit <pr> --add-label preview`. A bot then
  builds a seeded environment at `https://pr-<n>-portal.devmk8s.com` and
  comments the live URL on the PR (see gemini
  `docs/runbooks/feature-environments.md`, "Preview a PR"). Skip it for a
  docs-only or test-only PR, and for a PR from a fork or another repo. The
  label is best-effort: if it is refused (capacity, branch behind `main`),
  the bot removes it and says why in its comment; note that in the summary
  and carry on, never retry in a loop and never block the ticket on it.
  Previews are torn down after 7 days without a push.
- **Preview walk-through (gemini UI changes, after the `preview`
  label).** Once the PR is open and labeled `preview`, wait for the
  `preview-live` label (`gh pr view <pr> --json labels`, check every 60s,
  give up after 25 minutes). The URL is
  `https://pr-<n>-portal.devmk8s.com`. Live means the images built, so the
  first page load may fail for a few minutes while Argo rolls out; retry it.
  Then walk the feature in the user's signed-in Chrome (its Okta session
  signs in on its own):
  1. Call `mcp__claude-in-chrome__tabs_context_mcp`, then
     `mcp__claude-in-chrome__tabs_create_mcp`, and navigate the new tab to
     the preview URL. Work only in tabs you created.
  2. If a sign-in page appears, do not type any credentials: close your
     tabs, record `Preview: not walked (Chrome not signed in)`, and carry on.
  3. Navigate to each changed screen and do what the ticket's acceptance
     criteria describe. For each state worth showing, take a screenshot
     with the `computer` tool (`action: "screenshot", save_to_disk: true`)
     and immediately run `~/attach-ticket.sh <saved-path>`. It prints the
     asset URL and deletes the file. If it exits non-zero, run
     `shred -u <saved-path>` and continue without that image. Confirm the
     file is gone with `test ! -e <saved-path>`; if not, `shred -u` it.
     Never copy a screenshot anywhere else.
  4. Close your tabs with `mcp__claude-in-chrome__tabs_close_mcp`.
  5. Post one PR comment (`gh pr comment <pr> --body-file`; on a rerun use
     `--edit-last`) with the preview URL, a line per acceptance criterion
     saying what you did and what you saw, and the `![](<asset-url>)`
     images.
  - **If a criterion visibly fails:** fix the code, re-run the full test
    suite, push, wait for the new build to go live, and walk it again.
    After 3 failed rounds record `UAT: failed` with what you saw in the PR
    body and convert the PR to draft (`gh pr ready --undo`).
  - **If the label is refused or removed, or the preview is not live in
    time:** skip the walk-through, say why in the PR body, and carry on.
    Never block the ticket on the preview.
