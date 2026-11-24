---
name: spike-ticket
description: Use when pickup-ticket routes a spike ticket (deliverable is an answer or recommendation, not shipped code), to investigate, report findings on the ticket, and move it to Review without a PR.
---

# Spike Tickets

A spike's output is knowledge, not a PR. There is nothing to ship, so pickup-ticket's PR,
review, split, and local-server steps do not apply.

1. **Investigate** as cheaply as correctness allows. Any code you write is
   throwaway scaffolding: never open a PR for it.
2. **Leave no local-only work**, or the reaper will spare the worktree forever.
   Either discard the scaffolding (`git reset --hard` and
   `git clean -fd -e '.yimbot-*'` so yimbot's marker files survive), or if it
   is worth keeping for
   reference, commit and push the branch (`git push -u origin HEAD`, still no
   PR). The working tree must end clean with every commit on origin.
3. **Report findings on the ticket.** Post a comment with: the question, what
   you tried, the answer or recommendation, and suggested next steps (for
   example the follow-up ticket to write). Linear tickets (`eng-*`): write the
   markdown to a file and run `~/comment-ticket.sh <TICKET> - < findings.md`.
   Shortcut tickets (`sc-*`): use the Shortcut MCP.
4. **Move the ticket to the Review column.** Linear: run
   `~/move-ticket.sh <TICKET> "In Review"`. Shortcut: use the Shortcut MCP.
   Always Review, never Done: for Linear tickets the daemon checks the branch
   when the ticket enters review, and if it has no PR and no code it moves the
   ticket to Done itself and mentions the creator. Otherwise a human reads it
   there. The daemon then reaps this worktree and session, but only if step 2
   was honored. Shortcut tickets (`sc-*`) are not watched by the daemon: note
   in the findings summary that the session should be ended manually
   (`~/end-session.sh <branch>`).
5. **STOP.** Print the findings summary and where it was posted.
