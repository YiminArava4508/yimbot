---
name: refine-ticket
description: Use when a yimbot refine session opens on an unestimated Linear ticket, to size it and either estimate it in place or decompose it into pointed, dependency-ordered subtickets. Never writes code.
---

# Refine a Ticket

You are sizing one unestimated Linear ticket. Your only outputs are Linear
writes through the yimbot CLIs below. You never write code, never create
branches, worktrees, or PRs, and never move any ticket between workflow
states. The daemon watches the ticket's estimate: the moment one exists, this
session is done and will be reaped.

1. **Read the ticket.** You were seeded with its identifier and have already
   fetched it. Read the description, comments, and any linked context.

2. **Read enough of the codebase to judge scope.** You are in the main
   checkout, read-only. Explore the areas the ticket touches until you can
   estimate how large the change is in changed lines of code.

3. **Decide: right-sized or oversized.** Right-sized means one PR comfortably
   under 500 changed LOC (the same limit the pickup-ticket skill enforces at
   ship time). Oversized means it needs more than one PR.

4. **Right-sized: estimate it in place.**
   Run `~/estimate-ticket.sh <TICKET> <points>` with a points estimate that
   reflects the work (1 = trivial, 2 = small, 3 = a solid PR, 5 = a large
   single PR). Then go to step 6.

5. **Oversized: decompose into subtickets.**
   - Slice the work into independent, worker-sized pieces, each one PR well
     under 500 LOC. Slice along feature seams so every slice builds and tests
     green on its own.
   - For each slice, run:
     `~/create-subticket.sh <TICKET> "<slice title>" <points> --claimable --no-zero-parent`
     The subticket lands in Todo and the active cycle, assigned like the parent
     and carrying the parent's labels.
     Pass `--claimable` only when the parent ticket sits in the Todo column (an
     unstarted state); when the parent sits in Backlog, omit it so the pointed
     slices stay unscheduled for a human to plan. `--no-zero-parent` is passed
     either way.
   - For every pair where one slice needs another's changes merged first, run:
     `~/relate-tickets.sh <blocker-ticket> <blocked-ticket>`
     Wire only real dependencies; unrelated slices stay unblocked so they can
     be claimed in parallel.
   - Write each slice title so it stands alone: a worker session will pick the
     subticket up with no memory of this analysis. Put any slice-specific
     context (files involved, approach, gotchas) into the subticket
     description by passing it in the title only if short; otherwise add a
     comment on the subticket via the Linear MCP.
   - **Last action of this step, after every slice and every relation:** run
     `~/estimate-ticket.sh <TICKET> 0`. That zero is what marks the parent
     refined (a 0-point container the claim step never picks up), so it must
     come last: set it earlier and the daemon sees the estimate mid-way and
     reaps this session before the remaining slices exist.

6. **STOP.** Print a summary: the decision (estimated in place, or the list of
   subtickets with points and blocking order). Do not wait for the daemon; the
   session will be cleaned up once the estimate is visible.
