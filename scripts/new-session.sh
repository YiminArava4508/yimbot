#!/bin/bash
# new-session.sh - create (or reuse) a git worktree + tmux session for a branch,
# then open a Claude window in it. Generic: no project paths, stacks, or personal
# data are baked in. Configure with the env vars below and optional hooks.
#
# The yimbot daemon shells out to ~/new-session.sh when an issue enters the
# launch state. Install this generic launcher there (or point the daemon at your
# own) with, e.g.:
#     ln -s "$PWD/scripts/new-session.sh" ~/new-session.sh
#
# Config (all overridable via the environment):
#   CODEBASE_PATH          base git repo to branch from             (~/Work/gemini)
#   DEFAULT_BRANCH         branch new feature branches are cut from;
#                          auto-detected from origin/HEAD when unset (main)
#   WORKTREES_DIR          where worktrees are created              (~/Work/worktrees)
#   EDITOR                 editor for the optional edit windows     ($EDITOR, else vi)
#   SESSION_EDIT_DIRS      space-separated subdirs to open, each in
#                          its own editor window, e.g. "frontend backend"  (none)
#   SESSION_SETUP_HOOK     script run once after the worktree is
#                          created; receives "<worktree_path> <name>".
#                          Put project-specific port/env/dep setup here.  (none)
#   SESSION_LOCAL_ENV_CMD  command staged into a dedicated shell window's
#                          history (Up then Enter runs it) to start
#                          the local dev env on demand; the window is
#                          created only when this is set             (none)
#   SESSION_SETTINGS       settings JSON passed to `claude --settings`;
#                          a deny-list safety net. Loaded when the file
#                          exists.        (~/.config/yimbot/session-settings.json)
#   PLAN_MODEL             model the Claude session plans on;
#                          passed to `claude --model`               (Claude default)
#   IMPL_MODEL             model exported for the implementation
#                          subagents, read by the pickup-ticket skill (Claude default)

set -uo pipefail

WORKTREES_DIR=${WORKTREES_DIR:-$HOME/Work/worktrees}
EDITOR=${EDITOR:-vi}

# Where yimbot's event log lives, so this session's Claude hooks can append
# needs-input / input-received signals to the same log the TUI reads. The daemon
# exports an absolute path; default it from this script's own repo location
# (scripts/new-session.sh -> ../events.jsonl) for a hand-run session.
if [ -z "${EVENTS_LOG:-}" ]; then
  _self=$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")
  EVENTS_LOG="$(cd "$(dirname "$_self")/.." 2>/dev/null && pwd)/events.jsonl"
fi
export EVENTS_LOG

log() { echo "[$(date '+%H:%M:%S')] $*"; }
die() {
  log "ERROR: $*"
  exit 1
}

# Build the Claude seed prompt for a session name. Echoes a fetch-then-handoff
# prompt for recognized sessions (sc-<id>-… / eng-<id>-… ticket sessions, or
# pr-<n>-fix comment-fix sessions), or nothing for any other name. Kept as a pure
# function so it can be unit-tested via sourcing.
seed_prompt_for() {
  local name=$1
  if [[ "$name" =~ ^pr-([0-9]+)-fix$ ]]; then
    printf 'You are addressing review comments on pull request #%s, checked out in this worktree. Invoke the address-pr-comments skill and follow it exactly.' "${BASH_REMATCH[1]}"
  elif [[ "$name" =~ ^pr-([0-9]+)-ci$ ]]; then
    printf 'You are fixing failing CI on pull request #%s, checked out in this worktree. Invoke the fix-pr-ci skill and follow it exactly.' "${BASH_REMATCH[1]}"
  elif [[ "$name" =~ ^pr-([0-9]+)-conflict$ ]]; then
    printf 'You are resolving a merge conflict with main on pull request #%s, checked out in this worktree. Invoke the fix-pr-conflict skill and follow it exactly.' "${BASH_REMATCH[1]}"
  elif [[ "$name" =~ ^pr-([0-9]+)-blocked$ ]]; then
    printf 'You are unblocking pull request #%s, which the merge queue kicked out after its combined-CI batch failed, checked out in this worktree. Invoke the fix-pr-blocked skill and follow it exactly.' "${BASH_REMATCH[1]}"
  elif [[ "$name" =~ ^sc-([0-9]+)- ]]; then
    printf 'Fetch Shortcut story %s via the Shortcut MCP (mcp__shortcut__stories-get-by-id) and read its description, acceptance criteria, and comments. Then invoke the pickup-ticket skill and follow it exactly.' "${BASH_REMATCH[1]}"
  elif [[ "$name" =~ ^eng-([0-9]+)-cont-[0-9]+$ ]]; then
    printf 'Fetch Linear issue ENG-%s via the Linear MCP (mcp__linear-server__get_issue) and read the yimbot acceptance-criteria tracker comment. Implement ONLY the still-open (unchecked) criteria, cutting your PR from main. Then invoke the pickup-ticket skill and follow it exactly.' "${BASH_REMATCH[1]}"
  elif [[ "$name" =~ ^eng-([0-9]+)- ]]; then
    printf 'Fetch Linear issue ENG-%s via the Linear MCP (mcp__linear-server__get_issue) and read its description and comments. Then invoke the pickup-ticket skill and follow it exactly.' "${BASH_REMATCH[1]}"
  fi
}

# Echo the skill a seed prompt hands off to, or nothing. Every seed prompt uses
# the phrasing "the <name> skill", so one pattern covers all recognized sessions.
skill_in_prompt() {
  local prompt=$1
  [[ "$prompt" =~ the\ ([a-z0-9-]+)\ skill ]] && printf '%s' "${BASH_REMATCH[1]}"
}

# Reproduce deriveKey({branch}) from src/events.ts: an eng-/sc- ticket branch
# (any case) maps to the uppercased TICKET-NUMBER key; any other branch is its
# own key. Pure; unit-tested via sourcing.
event_key_from_branch() {
  local branch=$1 p n
  shopt -s nocasematch
  if [[ "$branch" =~ ^(eng|sc)-([0-9]+) ]]; then
    p=${BASH_REMATCH[1]}
    n=${BASH_REMATCH[2]}
    shopt -u nocasematch
    printf '%s-%s' "$(printf '%s' "$p" | tr '[:lower:]' '[:upper:]')" "$n"
    return
  fi
  shopt -u nocasematch
  printf '%s' "$branch"
}

# Append one yimbot flag signal (needs_input | input_received) for the current
# worktree to $EVENTS_LOG, keyed by its git branch, so the TUI can flag a session
# stuck waiting for input. Best-effort: a missing log or unresolvable branch is a
# silent no-op, never failing the Claude hook that calls it.
emit_hook_event() {
  local kind=$1 branch key ts
  [ -n "${EVENTS_LOG:-}" ] || return 0
  branch=$(git branch --show-current 2>/dev/null) || return 0
  [ -n "$branch" ] || return 0
  key=$(event_key_from_branch "$branch")
  # JSON-escape the key: git ref names legally allow " and \, and the
  # fallthrough in event_key_from_branch echoes such branches raw. Order
  # matters: backslash first, so escaping the quote doesn't get re-escaped.
  key=${key//\\/\\\\}
  key=${key//\"/\\\"}
  ts=$(( $(date +%s%N) / 1000000 ))
  printf '{"ts":%s,"kind":"%s","key":"%s","label":"%s"}\n' "$ts" "$kind" "$key" "$key" >> "$EVENTS_LOG" 2>/dev/null || true
}

# Notification types that do not mean a human is blocking: the ~60s idle prompt
# (which an autonomous session hits routinely while its background agents work),
# plus auth and completion notices.
NOTIFY_QUIET="idle_prompt auth_success elicitation_complete elicitation_response agent_completed"

# Claude Code Notification hook: reads the hook payload on stdin and emits
# needs_input only when the notification means the session is waiting on a
# person. Anything not in NOTIFY_QUIET flags, including a type this build has
# never seen, so a new kind of block is never silently swallowed.
emit_notification_event() {
  local payload="" type=""
  # Only read a real pipe: a hand-run in a terminal would otherwise hang on cat.
  [ -t 0 ] || payload=$(cat 2>/dev/null)
  type=$(printf '%s' "$payload" |
    sed -n 's/.*"notification_type"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  case " $NOTIFY_QUIET " in *" $type "*) return 0 ;; esac
  emit_hook_event needs_input
}

# Fail fast if this session hands off to a skill that isn't installed, rather than
# launching a session that will stall on an unknown skill. No skill named: no-op.
verify_seed_skill() {
  local name=$1 prompt skill dir
  prompt=$(seed_prompt_for "$name")
  skill=$(skill_in_prompt "$prompt")
  [ -n "$skill" ] || return 0
  dir=${SKILLS_DIR:-$HOME/.claude/skills}
  [ -f "$dir/$skill/SKILL.md" ] ||
    die "skill '$skill' not installed at $dir/$skill (run 'pnpm onboard' in the yimbot repo, or restart the daemon to self-heal links)"
}

# Resolve a repo's default branch: honor DEFAULT_BRANCH, else read origin/HEAD
# (repairing it from the remote when unset), else fall back to "main". Pure
# w.r.t. env; unit-tested via sourcing (override + fallback paths).
default_branch_of() {
  local repo=$1
  if [ -n "${DEFAULT_BRANCH:-}" ]; then
    printf '%s' "$DEFAULT_BRANCH"
    return
  fi
  local ref
  ref=$(git -C "$repo" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)
  if [ -z "$ref" ]; then
    git -C "$repo" remote set-head origin --auto >/dev/null 2>&1
    ref=$(git -C "$repo" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)
  fi
  ref=${ref#origin/}
  printf '%s' "${ref:-main}"
}

# --- Create or reuse the worktree ---
# Reuse if fully set up; prune a stale git registration whose dir is gone; remove
# a leftover dir that git doesn't know about; then add the worktree, checking out
# an existing branch (local or origin) or creating a new one.
create_worktree() {
  local registered=false
  if git -C "$CODEBASE_PATH" worktree list --porcelain | grep -qF "worktree $WORKTREE"; then
    registered=true
  fi
  if $registered && [ -d "$WORKTREE" ]; then
    log "Worktree already exists at $WORKTREE"
    return 0
  fi
  if $registered && [ ! -d "$WORKTREE" ]; then
    log "Pruning stale worktree registration (directory missing)"
    git -C "$CODEBASE_PATH" worktree prune
  elif [ -d "$WORKTREE" ]; then
    log "Removing stale directory $WORKTREE (not a registered worktree)"
    rm -rf "$WORKTREE"
  fi
  mkdir -p "$WORKTREES_DIR"
  # A branch passed explicitly (PR fix) may live only on origin; fetch it so the
  # remote-tracking ref below resolves.
  [ "$BRANCH" != "$NAME" ] && git -C "$CODEBASE_PATH" fetch origin "$BRANCH" >/dev/null 2>&1
  if git -C "$CODEBASE_PATH" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    log "Checking out existing local branch '$BRANCH'"
    git -C "$CODEBASE_PATH" worktree add "$WORKTREE" "$BRANCH" || die "git worktree add failed"
  elif git -C "$CODEBASE_PATH" show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
    log "Checking out origin branch '$BRANCH'"
    git -C "$CODEBASE_PATH" worktree add --track -b "$BRANCH" "$WORKTREE" "origin/$BRANCH" ||
      die "git worktree add failed"
  else
    git -C "$CODEBASE_PATH" fetch origin "$DEFAULT_BRANCH" >/dev/null 2>&1
    if git -C "$CODEBASE_PATH" show-ref --verify --quiet "refs/remotes/origin/$DEFAULT_BRANCH"; then
      log "Creating new branch '$BRANCH' from origin/$DEFAULT_BRANCH"
      git -C "$CODEBASE_PATH" worktree add "$WORKTREE" -b "$BRANCH" "origin/$DEFAULT_BRANCH" ||
        die "git worktree add failed"
    else
      log "origin/$DEFAULT_BRANCH unavailable; creating '$BRANCH' from current HEAD"
      git -C "$CODEBASE_PATH" worktree add "$WORKTREE" -b "$BRANCH" || die "git worktree add failed"
    fi
  fi
}

# Assemble the claude command. Runs in auto mode so pickup / PR-fix sessions let
# the classifier auto-approve safe actions and start without the bypass-mode
# confirmation screen; loads the deny-list settings when present (a safety net
# that blocks catastrophic commands without prompting); uses the planning model
# if set and passes the implementation model through the environment for the
# pickup-ticket skill (all optional). Pure (reads env + checks one file);
# unit-tested via sourcing.
build_claude_cmd() {
  local cmd="claude --permission-mode auto"
  local settings=${SESSION_SETTINGS:-$HOME/.config/yimbot/session-settings.json}
  [ -f "$settings" ] && cmd="$cmd --settings $settings"
  [ -n "${PLAN_MODEL:-}" ] && cmd="$cmd --model $PLAN_MODEL"
  # Resume mode: reattach to the worktree's prior conversation instead of a fresh
  # start, so a re-couple (session died, worktree lives) never re-runs the seed.
  [ -n "${SESSION_RESUME:-}" ] && cmd="$cmd --continue"
  [ -n "${IMPL_MODEL:-}" ] && cmd="IMPL_MODEL=$IMPL_MODEL $cmd"
  printf '%s' "$cmd"
}

# Launch Claude in a tmux target (session:window), seeding the ticket/PR prompt
# when the session name is recognized. In resume mode no seed is sent: --continue
# reopens the prior conversation and a fresh prompt would restart the work.
launch_claude_in() {
  local target=$1
  local cmd
  cmd=$(build_claude_cmd)
  local prompt=""
  [ -z "${SESSION_RESUME:-}" ] && prompt=$(seed_prompt_for "$NAME")
  if [ -n "$prompt" ]; then
    tmux send-keys -t "$target" "$cmd \"$prompt\"" C-m
  else
    tmux send-keys -t "$target" "$cmd" C-m
  fi
}

# When sourced (e.g. by a test) load the functions above and stop; only run
# session setup when the script is executed directly.
(return 0 2>/dev/null) && return 0

NAME=${1:-}
[ -n "$NAME" ] || {
  echo "Usage: $0 <name> [branch]"
  exit 1
}
# Optional 2nd arg: the branch to check out. Defaults to the session name (a
# normal ticket session branches on its own name). PR fix sessions pass the PR's
# branch here so the tmux session is named by PR (pr-<n>-fix) while the worktree
# is keyed by (and reuses) the branch's existing worktree.
BRANCH=${2:-$NAME}

CODEBASE_PATH=${CODEBASE_PATH:-$HOME/Work/gemini}
git -C "$CODEBASE_PATH" rev-parse --git-dir >/dev/null 2>&1 ||
  die "CODEBASE_PATH is not a git repo: $CODEBASE_PATH"

# The default branch new feature branches are cut from (create_worktree reads it).
DEFAULT_BRANCH=$(default_branch_of "$CODEBASE_PATH")

# Sanitize the branch into a worktree dir (same rule the daemon's slug uses).
WORKTREE_DIR=$(echo "$BRANCH" | sed 's/[^a-zA-Z0-9-]/-/g' | cut -c1-50)
WORKTREE=$WORKTREES_DIR/$WORKTREE_DIR

# Fail before creating any worktree/session if the seed hands off to a skill that
# isn't installed on this host.
verify_seed_skill "$NAME"

# Create or reuse the worktree.
create_worktree

# Mark this worktree as a launch in progress until the script exits. The tmux
# session is created only after the (possibly slow) setup hook below, so between
# now and then the worktree is session-less; without this the daemon's orphan
# sweep could mistake it for an abandoned worktree and tear it down mid-launch.
# The EXIT trap clears it on every path: on success a session now exists, and on
# a failed launch (die) the cleared marker lets the sweep reap the dead worktree.
LAUNCH_MARKER="$WORKTREE/.yimbot-launching"
if ! : > "$LAUNCH_MARKER" 2>/dev/null; then
  log "WARN: could not write launch marker $LAUNCH_MARKER; orphan sweep falls back to the age guard for this launch"
fi
trap 'rm -f "$LAUNCH_MARKER"' EXIT

# --- PR fix into the ticket's existing session ---
# A fix invocation (BRANCH != NAME) whose branch has a live ticket session
# (named after the sanitized branch, == WORKTREE_DIR) is added as a detached
# window there rather than a standalone session, so a PR and its ticket share one
# session. No setup hook: the ticket session already ran it on this worktree.
if [ "$BRANCH" != "$NAME" ] && tmux has-session -t "=$WORKTREE_DIR" 2>/dev/null; then
  log "Adding fix window '$NAME' to ticket session '$WORKTREE_DIR'"
  tmux new-window -d -t "$WORKTREE_DIR" -n "$NAME" -c "$WORKTREE" ||
    die "Failed to add window '$NAME' to session '$WORKTREE_DIR'"
  launch_claude_in "$WORKTREE_DIR:$NAME"
  log "Fix window added (detached)"
  exit 0
fi

# --- Optional project-specific setup (ports, env files, dependency installs) ---
if [ -n "${SESSION_SETUP_HOOK:-}" ]; then
  if [ -f "$SESSION_SETUP_HOOK" ]; then
    log "Running setup hook: $SESSION_SETUP_HOOK"
    bash "$SESSION_SETUP_HOOK" "$WORKTREE" "$NAME" || die "setup hook failed"
  else
    log "WARN: SESSION_SETUP_HOOK set but not found: $SESSION_SETUP_HOOK"
  fi
fi

# --- Tmux session ---
if tmux has-session -t "$NAME" 2>/dev/null; then
  log "Session '$NAME' already exists, switching to it..."
  if [ -n "${TMUX:-}" ]; then
    tmux switch-client -t "$NAME" || die "Failed to switch to session '$NAME'"
  elif [ -t 0 ]; then
    tmux attach -t "$NAME" || die "Failed to attach to session '$NAME'"
  else
    log "No TTY; session '$NAME' already running, leaving detached"
  fi
  exit 0
fi

# Capture the first window id so the script is independent of base-index.
FIRST_INFO=$(tmux new-session -d -s "$NAME" -c "$WORKTREE" -P -F '#{window_id} #{pane_id}') ||
  die "Failed to create tmux session '$NAME'"
read -r FIRST_WINDOW _FIRST_PANE <<<"$FIRST_INFO"
log "Tmux session created"

# Window 0 is the Claude AI window: the session is a single window by default.
# Ticket sessions (sc-<id>-… / eng-<id>-…) are seeded to fetch the ticket and hand
# off to the pickup-ticket skill; any other name gets a bare claude.
tmux rename-window -t "$FIRST_WINDOW" Claude

# Optional shell window: created only when a local-env command is configured, so
# it can be staged in that window's history (Up + Enter) rather than auto-started.
if [ -n "${SESSION_LOCAL_ENV_CMD:-}" ]; then
  tmux new-window -t "$NAME" -n shell -c "$WORKTREE"
  tmux send-keys -t "$NAME:shell" "echo 'Local dev not started. Press Up then Enter to run: $SESSION_LOCAL_ENV_CMD'" C-m
  tmux send-keys -t "$NAME:shell" "history -s '$SESSION_LOCAL_ENV_CMD'" C-m
fi

# Optional editor windows, one per configured subdir.
for dir in ${SESSION_EDIT_DIRS:-}; do
  tmux new-window -t "$NAME" -n "$dir" -c "$WORKTREE/$dir"
  tmux send-keys -t "$NAME:$dir" "$EDITOR" C-m
done

launch_claude_in "$NAME:Claude"

log "All windows set up. Switching to session '$NAME'"
tmux select-window -t "$FIRST_WINDOW"

# Switch if already in tmux, attach on a terminal; when launched headless (e.g. by
# the yimbot daemon) leave the session detached and exit 0.
if [ -n "${TMUX:-}" ]; then
  tmux switch-client -t "$NAME" || die "Failed to switch to session '$NAME'"
elif [ -t 0 ]; then
  tmux attach -t "$NAME" || die "Failed to attach to session '$NAME'"
else
  log "No TTY; session '$NAME' left detached"
fi
