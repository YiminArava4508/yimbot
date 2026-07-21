# Autonomous Ticket Pickup — Design

**Date:** 2026-07-21
**Status:** Approved (design), pending implementation plan

## Problem

When an issue enters *In Progress*, the daemon launches a worktree + tmux
session and seeds Claude with a single instruction: fetch the ticket, invoke
`writing-plans`, produce a plan, then **stop before writing any code**.

Everything after the plan is hand-driven. In practice the recurring friction is
the **plan → implement handoff**: the plan/design gets written, then the human
must manually carry that design into the implementation step every time. The
goal is to remove that shuttle step while keeping a checkpoint only where it
earns its keep.

## Goal

After the plan is written, Claude should **auto-implement small, localized
plans** and **pause for an explicit "go" only when the plan is genuinely
risky**. Implementation stops when the test suite is green — it does **not**
auto-create a PR or push.

Non-goals (explicitly out of scope for this change):

- Automatic PR creation, push, or review-comment handling.
- Changing the *In Review* trigger behavior (still just resumes the dev env).
- Any change to how sessions/worktrees are created.

## Key decision: risk classification lives with Claude, post-plan

"Small & localized" is a property of **the plan**, not of ticket metadata. The
daemon can only see Linear fields (estimate, labels) — it cannot know how many
files a plan touches or whether a migration is involved. That signal only
exists *after* `writing-plans` runs. Therefore classification is performed by
Claude as a step in the seeded flow, not by the daemon.

## Approach: committed pickup-flow file + thin seed prompt

The full autonomous flow and the risk rubric live in **one versioned markdown
file**, and the seed prompt in `new-session.sh` shrinks to a thin pointer:
"read the ticket for issue X, then follow the pickup-ticket flow."

Rationale over the alternatives:

- **vs. prompt-only:** keeps the rubric out of a bash-escaped heredoc (painful
  to edit) and out of two duplicated branches (`eng-*` and `sc-*`).
- **vs. daemon-side classification:** the daemon lacks plan-scope signal (see
  decision above), so risk logic there would be blind to the strongest signals.

One versioned file → one place to tune the rubric, editable without bash
escaping, reusable across `eng-*` (Linear) and `sc-*` (Shortcut) sessions, and
invocable by hand.

## Components

### 1. Pickup-flow instruction file

A user-level skill at `~/.claude/skills/pickup-ticket/SKILL.md` encoding the
flow below and the risk rubric. Chosen over a plain prompt doc because the flow
already composes `superpowers:*` skills, so a skill invocation (`Skill` tool /
`/pickup-ticket`) is the idiomatic entry point, is invocable by hand, and is
reusable across `eng-*` and `sc-*` sessions. It is the single source of truth
for both the flow and the rubric so both trigger branches share it.

### 2. Seed prompt in `new-session.sh`

Both the Linear (`ISSUE_ID`) and Shortcut (`STORY_ID`) branches change from
"fetch, plan, stop" to "fetch the ticket, then follow the pickup-ticket flow."
The ticket-fetch MCP call differs per branch (Linear MCP vs. Shortcut MCP); the
flow reference is identical.

## Flow

1. **Fetch** the issue via the appropriate MCP (`mcp__linear-server__get_issue`
   or `mcp__shortcut__stories-get-by-id`); read description, acceptance
   criteria, comments.
2. **Plan** — invoke `superpowers:writing-plans`; design doc is written to
   `docs/superpowers/specs/`.
3. **Classify** the plan against the risk rubric.
4. **Branch:**
   - **HIGH RISK** → print a concise risk summary (which trigger(s) fired) and
     the plan location, then **stop and wait for an explicit "go."**
   - **LOW RISK** → proceed automatically into `superpowers:executing-plans`
     with `superpowers:test-driven-development`, implement the plan, run the
     suite.
5. **Stop at green tests** with a summary of what changed and the test result.
   No PR, no push.

## Risk rubric

Treat the plan as **HIGH RISK** (pause for "go") if **any** of the following
hold; otherwise **LOW RISK** (auto-implement):

- The plan involves a **database migration or schema change**.
- The plan touches **auth, billing/payments, or shared/core libraries**.
- The plan touches **more than ~8 files** (threshold tunable).
- The ticket has an **estimate above threshold** or carries a **risk-ish label**
  (e.g. `migration`, `infra`, `breaking`).
- The plan itself contains **open questions or flagged uncertainty**.

When HIGH RISK, the printed summary names which specific trigger(s) fired so the
human can make a fast call.

## Error handling

- **Ticket fetch fails / issue unreadable:** stop and report; do not plan blind.
- **Plan step produces open questions:** this is itself a HIGH-RISK trigger →
  pause for "go" rather than guessing.
- **Tests fail during auto-implement:** follow `test-driven-development` /
  `systematic-debugging` to resolve; if genuinely blocked, stop with the
  failing output rather than forcing green.
- **Classification ambiguity:** default to HIGH RISK (pause). Bias toward asking
  when unsure.

## Testing

The behavioral change is in the seed prompt + instruction file, not in daemon
TypeScript, so the existing 27/27 daemon tests are unaffected and should stay
green (`pnpm typecheck` + tests). Validation of the new flow is manual:

- Low-risk ticket → session auto-implements to green tests without re-prompting.
- High-risk ticket (e.g. one touching a migration) → session halts after the
  plan with a summary naming the fired trigger(s).

Because the skill lives outside the repo (`~/.claude/skills/`), consider a light
existence check in `new-session.sh` before seeding — warn if the skill file is
missing (parity with the existing `index.ts` hard-require on
`~/run-local-env.sh`).
