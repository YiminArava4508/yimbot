#!/bin/bash
# wait-local-env.sh - block until a worktree's local stack (API + React) is
# listening, then print the React base URL. Pairs with run-local-env.sh, which
# returns before the servers are up.
#
# Usage: wait-local-env.sh <worktree-dir> [timeout-seconds]   (default 600)
# Exit: 0 up (URL on stdout), 1 missing .env.worktree or port, 2 timed out.

read_env_port() { # file key
  grep -m1 "^$2=" "$1" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' \r'
}

port_listening() { # port
  lsof -Pi ":$1" -sTCP:LISTEN -t >/dev/null 2>&1
}

main() {
  local worktree=${1:?usage: wait-local-env.sh <worktree-dir> [timeout-seconds]}
  local timeout=${2:-600}
  local interval=${WAIT_LOCAL_ENV_INTERVAL:-5}
  local env_file="$worktree/.env.worktree"

  if [ ! -f "$env_file" ]; then
    echo "wait-local-env: no $env_file" >&2
    exit 1
  fi

  local app_port react_port
  app_port=$(read_env_port "$env_file" APP_PORT)
  react_port=$(read_env_port "$env_file" REACT_UI_PORT)
  if [ -z "$app_port" ] || [ -z "$react_port" ]; then
    echo "wait-local-env: APP_PORT or REACT_UI_PORT missing from $env_file" >&2
    exit 1
  fi

  local start=$SECONDS
  until port_listening "$app_port" && port_listening "$react_port"; do
    if [ $((SECONDS - start)) -ge "$timeout" ]; then
      echo "wait-local-env: ports $app_port/$react_port not listening after ${timeout}s" >&2
      exit 2
    fi
    sleep "$interval"
  done

  echo "http://localhost:$react_port"
}

(return 0 2>/dev/null) && return 0
main "$@"
