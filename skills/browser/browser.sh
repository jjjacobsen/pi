#!/usr/bin/env bash
set -euo pipefail

browser="${AGENT_BROWSER_EXECUTABLE_PATH:-$(command -v chromium || command -v chromium-browser || :)}"
[ -n "$browser" ] && [ -x "$browser" ] || { printf 'System Chromium not found. Set AGENT_BROWSER_EXECUTABLE_PATH\n' >&2; exit 1; }

agent-browser --session browser \
  --executable-path "$browser" --profile "$HOME/.pi/agent/browser/profile" \
  --headed "${AGENT_BROWSER_HEADED:-false}" --idle-timeout 10m \
  --args "--no-startup-window${AGENT_BROWSER_ARGS:+,$AGENT_BROWSER_ARGS}" "$@"

if [[ "${1:-}" == close ]]; then
  for attempt in {1..50}; do
    sessions="$(agent-browser session list --json)"
    [[ "$sessions" != *'"browser"'* ]] && exit 0
    sleep 0.1
  done
  printf 'Browser session did not stop after close\n' >&2
  exit 1
fi
