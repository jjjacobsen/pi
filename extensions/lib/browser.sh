#!/usr/bin/env bash
set -euo pipefail
umask 077

namespace="${1:?Browser namespace required}"
session="${2:?Browser session required}"
browser="${3:?Browser executable required}"
config="${4:?Browser config required}"
shift 4
[[ "$namespace" =~ ^pi-[a-f0-9]{16}$ ]] || { printf 'Invalid owned browser namespace\n' >&2; exit 1; }
[[ "$session" =~ ^pi-[a-f0-9]{12}$ ]] || { printf 'Invalid owned browser session\n' >&2; exit 1; }

[ -x "$browser" ] || { printf 'System Chromium not found. Set AGENT_BROWSER_EXECUTABLE_PATH\n' >&2; exit 1; }
[ -f "$config" ] || { printf 'Owned browser config not found\n' >&2; exit 1; }

# No inherited profile, restore state, provider, CDP attachment, plugin, or launch settings.
# The native browser creates and removes its own temporary profile.
for name in "${!AGENT_BROWSER_@}"; do unset "$name"; done
# These native env settings also reach dashboard /api/exec children. Keep the
# config until both dashboard and browser stop, so no child loads project config.
export AGENT_BROWSER_CONFIG="$config"
export AGENT_BROWSER_NAMESPACE="$namespace"
export AGENT_BROWSER_SESSION="$session"
export AGENT_BROWSER_EXECUTABLE_PATH="$browser"
export AGENT_BROWSER_ENGINE=chrome
export AGENT_BROWSER_HEADED=false
export AGENT_BROWSER_IDLE_TIMEOUT_MS=600000
native() {
  agent-browser "$@"
}
native "$@"

if [[ "${1:-}" == close ]]; then
  for attempt in {1..50}; do
    info="$(native session info --json)"
    [[ "$info" =~ \"active\"[[:space:]]*:[[:space:]]*false ]] && exit 0
    sleep 0.1
  done
  printf 'Owned browser session did not stop after close\n' >&2
  exit 1
fi
