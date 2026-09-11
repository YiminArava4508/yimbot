#!/bin/bash
# no-self-rebase.sh - PreToolUse hook that denies rebasing a branch onto its own
# remote (`git pull --rebase`, `git rebase origin/<branch>`, `git rebase @{u}`).
#
# Why: fix sessions bring main in with a merge. If the remote branch has moved
# (a bot pushed), a rebase onto it flattens that merge and replays main's commits
# onto the PR as duplicates, and the push then fast-forwards, so the force-push
# deny-list never catches it. Rebasing onto anything else still needs a force
# push to land, which the deny-list already blocks.
#
# Subcommands:
#   pre   PreToolUse hook. Reads the payload on stdin, prints a deny decision on
#         a match, nothing otherwise. Every failure path exits 0.

set -uo pipefail

payload_field() {
  printf '%s' "$1" | jq -er "$2" 2>/dev/null
}

# Split a shell command on && ; || | so each git invocation is judged alone.
split_segments() {
  printf '%s\n' "$1" | sed -E 's/&&|\|\||;|\|/\n/g'
}

# Tokens of a segment. Quotes are not parsed: the arguments we look for never
# need them, and a quoted `$(git branch --show-current)` reads as loose tokens.
segment_tokens() {
  local seg=$1
  read -r -a TOKENS <<<"$seg"
}

# is_self_rebase <command> <current-branch>: 0 when the command rebases the
# branch onto its own remote. The branch may be empty, which disables the
# `git rebase` check (the pull form needs no branch to judge).
is_self_rebase() {
  local cmd=$1 branch=$2 seg
  while IFS= read -r seg; do
    segment_tokens "$seg"
    local n=${#TOKENS[@]} i=0
    while [ $i -lt $n ] && [ "${TOKENS[$i]}" != git ]; do i=$((i+1)); done
    [ $i -ge $n ] && continue
    i=$((i+1))
    while [ $i -lt $n ] && [[ ${TOKENS[$i]} == -* ]]; do i=$((i+1)); done
    [ $i -ge $n ] && continue
    local sub=${TOKENS[$i]}
    i=$((i+1))
    local args=("${TOKENS[@]:$i}")
    case $sub in
      pull) pull_rebases "${args[@]+"${args[@]}"}" && return 0 ;;
      rebase) [ -n "$branch" ] && rebase_targets_self "$branch" "${args[@]+"${args[@]}"}" && return 0 ;;
    esac
  done < <(split_segments "$cmd")
  return 1
}

pull_rebases() {
  local t
  for t in "$@"; do
    case $t in
      --rebase=false|--no-rebase|--ff-only) return 1 ;;
      --rebase|--rebase=*) return 0 ;;
      --*) ;;
      -*r*) return 0 ;;
    esac
  done
  return 1
}

rebase_targets_self() {
  local branch=$1 t
  shift
  for t in "$@"; do
    case $t in
      origin/"$branch"|@\{u\}|@\{upstream\}|"$branch"@\{u\}|"$branch"@\{upstream\}) return 0 ;;
    esac
  done
  return 1
}

# A bare `git pull` with pull.rebase=true in the repo is a rebase too.
pull_rebases_by_config() {
  local cmd=$1 cwd=$2
  [ "$(git -C "$cwd" config --get pull.rebase 2>/dev/null)" = true ] || return 1
  local seg
  while IFS= read -r seg; do
    segment_tokens "$seg"
    local n=${#TOKENS[@]} i=0
    while [ $i -lt $n ] && [ "${TOKENS[$i]}" != git ]; do i=$((i+1)); done
    i=$((i+1))
    while [ $i -lt $n ] && [[ ${TOKENS[$i]} == -* ]]; do i=$((i+1)); done
    [ $i -lt $n ] && [ "${TOKENS[$i]}" = pull ] && ! pull_merges "${TOKENS[@]:$((i+1))}" && return 0
  done < <(split_segments "$cmd")
  return 1
}

pull_merges() {
  local t
  for t in "$@"; do
    case $t in --rebase=false|--no-rebase|--ff-only) return 0 ;; esac
  done
  return 1
}

deny() {
  local branch=$1
  local target=${branch:-"<branch>"}
  jq -n --arg b "$target" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: ("yimbot: this rebases the branch onto its own remote. That flattens the merge from main and replays main'"'"'s commits onto the PR as duplicates. Merge the remote instead: git pull --no-rebase --no-edit origin " + $b + " && git push. If that conflicts, git merge --abort, leave the session open, and report that the branch diverged. Never force push.")
    }
  }'
}

cmd_pre() {
  local payload cmd cwd branch
  payload=$(cat)
  cmd=$(payload_field "$payload" '.tool_input.command') || return 0
  cwd=$(payload_field "$payload" '.cwd') || cwd=$PWD
  branch=$(git -C "$cwd" branch --show-current 2>/dev/null || true)
  if is_self_rebase "$cmd" "$branch" || pull_rebases_by_config "$cmd" "$cwd"; then
    deny "$branch"
  fi
  return 0
}

# Source-guard: sourcing loads the helpers, executing dispatches a subcommand.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case ${1:-} in
    pre) cmd_pre ;;
    *) echo "usage: no-self-rebase.sh pre" >&2; exit 2 ;;
  esac
  exit 0
fi
