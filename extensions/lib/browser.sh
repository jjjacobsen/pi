#!/usr/bin/env bash
set -euo pipefail
umask 077

namespace="${1:?Browser namespace required}"
session="${2:?Browser session required}"
browser="${3:?Browser executable required}"
config="${4:?Browser config required}"
shift 4

# Use a temporary native profile, not inherited attachment or daily-profile settings.
# The dashboard's CLI children must use these same settings on every call.
for name in "${!AGENT_BROWSER_@}"; do unset "$name"; done
export AGENT_BROWSER_CONFIG="$config"
export AGENT_BROWSER_NAMESPACE="$namespace"
export AGENT_BROWSER_SESSION="$session"
export AGENT_BROWSER_EXECUTABLE_PATH="$browser"
export AGENT_BROWSER_ENGINE=chrome
export AGENT_BROWSER_HEADED=false
exec agent-browser "$@"
