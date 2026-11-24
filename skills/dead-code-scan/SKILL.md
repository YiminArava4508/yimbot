---
name: dead-code-scan
description: Use when a yimbot self-improve-dead-code-scan session starts, to find provably dead exports in the yimbot repo, remove them with their tests, and open a draft PR.
---

# Dead code scan

First, invoke the `self-improve-contract` skill and follow it for scope, verification
and shipping. This skill defines what "dead" means for this job.

## Candidates

List every `export` (function, const, class, type, interface, enum) in `src/*.ts`
and `index.ts`, skipping `*.test.ts` and `*.d.ts`. For each, grep the symbol as a
whole word across `index.ts`, `src`, `scripts`, `skills`, `settings`, `README.md`
and `.env.example`, excluding `*.test.ts`.

## Provable means all of

- No match outside the defining file, in any of those places.
- Inside the defining file it is unused too, or used only by other candidates you
  are removing in the same pass.
- No computed reference could name it: no template literal or `import()` building
  that symbol's name, no string-keyed lookup table that lists it.
- It is not a `type` or `interface` that other code consumes through inference.

## Never in scope

- Env var shims and fallbacks, legacy state-file parsing and migration code.
- Helpers that only tests use but are kept on purpose for tests (`tempDir` and
  similar test utilities).
- Anything the README or a skill names.
- Anything whose last caller was removed less than a day ago in `git log`.

## Removing

Remove the candidate and the tests that exist only for it. A test that also covers
live code is edited, not deleted. Drop imports and comments that only served the
removed code. Remove candidates one at a time and run `pnpm typecheck` after each so
a break points at one symbol.
