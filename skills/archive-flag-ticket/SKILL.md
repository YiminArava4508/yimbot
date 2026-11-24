---
name: archive-flag-ticket
description: Use when pickup-ticket routes an after-release "Archive `<flag>` flag in prod" ticket, to run the fail-closed checklist and archive the PostHog flag only when every check passes.
---

# Flag Archive Tickets

An after-release "Archive `<flag>` flag in prod" ticket may archive the flag
itself, but only through this checklist. There is no PR, review, split, or
local-server step. Read the exact flag key and PostHog flag ID from the ticket
description (`~/get-ticket.sh <TICKET>`) when it has `Flag key:` and `PostHog
flag ID:` lines; the ID must resolve to that key in prod project 117986. Older
tickets have no such lines: take the key from the backticked name in the title
("Archive `hubspot-call-list-sync` flag in prod"), search prod project 117986
for that exact key, and require exactly one flag with that key. Missing lines
alone never fail check 5. It fails only when the key can't be found or matches
more than one flag.

**Fail closed.** If any input can't be read (gh, git, Linear, PostHog), that
check fails. Never pass a check on missing data, and never skip one.

1. **Run the reference checks (checks 2 and 3).** `~/flag-archive-check.sh <key>`
   prints JSON (`pass`, `checks`, `builds`, `prodShas`, `docMatches`,
   `ignoredMatches`, `quietHours`) and exits non-zero on failure. It covers: no
   code references on `origin/main` of MatthewsREIS/gemini or anywhere else in
   the org, and none in the source folder of each gemini build prod runs (each
   app's chart and its local subcharts, at the commit their `appVersion` names;
   `builds` lists every app, chart, commit, and folder searched). `*.md` files
   are never searched in prod builds; on `origin/main` and the org they land in
   `docMatches` and don't fail. A code reference, in a non-test file, is the
   exact key as a quoted string (`"key"`, `'key'`, `` `key` ``), the key as a
   whole token in a config file (yaml, json, tf, `.env`, ...), or `.key` /
   `key:` in code. Every other match
   (the key inside a comment or a longer name such as a bucket or option, a test
   id, a mock, anything in a test file) lands in `ignoredMatches` and doesn't
   fail. The check is the gate: don't second-guess an ignored match, and don't
   override a failure because a hit "looks harmless"; raise needs-decision
   instead.
2. **Check 1, released.** The `Blocked by:` line of `~/get-ticket.sh <TICKET>`
   must list at least one blocker, and every blocker must be `Done`. The
   claim gate already checked this; re-check it anyway.
3. **Check 4, quiet in prod.** With the PostHog MCP, read the flag in project
   117986. `last_called_at` must be older than `quietHours` from step 1 (4
   unless `FLAG_ARCHIVE_QUIET_HOURS` is set). A null or missing `last_called_at`
   means the flag was never called: the check passes, and the readback says
   "never called". If the flag can't be read (PostHog error, flag not found),
   the check fails; that is not the same as never called.
4. **Check 5, nothing depends on it and archiving changes nothing for users.**
   In project 117986 all of these must hold:
   - no experiments, surveys, early-access features, or scheduled changes use
     the flag;
   - no other flag depends on it (search other flags' filters for this flag's
     ID);
   - session replay isn't linked to it;
   - the flag is active, at 100% rollout, with no release conditions.
   Product tours are out of scope (the PostHog key can't read them). Don't
   fail on them, but say so in the readback.

**If every check passes**, in this order:

a. **Save the flag's state** as a comment on the ticket before touching it: id,
   key, active, filters/rollout, `last_called_at`, enough to restore it.
b. **Archive the flag** with the PostHog MCP.
c. **Read it back** and confirm it now reads as archived. If it doesn't, raise
   needs-decision (below) with what you saw and stop.
d. **Post a readback comment** listing every check with its evidence, the prod
   commits searched (`prodShas`), any `docMatches`, any `ignoredMatches` (so a
   reviewer can audit what the check skipped), and the note that tours weren't
   checked.
e. **Move the ticket to In Review**, same as the spike flow: `~/move-ticket.sh
   <TICKET> "In Review"` (Shortcut: use the Shortcut MCP). No PR. Then STOP and
   print the readback.

**If any check fails**, archive nothing:

a. Run `~/needs-decision.sh "<failed check number and name>: <evidence>"` so
   the board stops showing the session as "working".
b. Post the same failed check and evidence as a comment on the ticket.
c. STOP.

## Why this may touch prod

This checklist is the one exception to pickup-ticket's Hard-Stop Rubric:
archiving a prod PostHog flag is allowed without a "go", only through this
checklist, and only when every check passes.
Every other prod change still needs a "go".
