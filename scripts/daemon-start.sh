#!/usr/bin/env bash
# Start the persistent lightpanda daemon behind the browser_* tools when it
# is not running
#
# It runs as a launchd LaunchAgent so it survives reboots and is restarted by
# launchd if it crashes. The plist is rendered from the template in scripts/
# into ~/Library/LaunchAgents on demand with this machine's paths, so a second
# computer only needs lightpanda installed before this task runs
#
# Uninstall: launchctl bootout gui/$(id -u)/<label> and delete the matching
# ~/Library/LaunchAgents plist.
set -euo pipefail

LP_LABEL=com.pijon.lightpanda
LP_PLIST="$HOME/Library/LaunchAgents/$LP_LABEL.plist"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LP_TEMPLATE="$REPO_DIR/scripts/$LP_LABEL.plist"

# Bootstrap a LaunchAgent plist, handling the case where the agent is
# already loaded but the process is dead: bootout, then bootstrap fresh.
bootstrap_agent() {
  local label="$1" plist="$2"
  launchctl bootstrap gui/$(id -u) "$plist" 2>/dev/null \
    || { launchctl bootout gui/$(id -u)/$label >/dev/null 2>&1 || true; launchctl bootstrap gui/$(id -u) "$plist"; }
}

# --- lightpanda (headless browser) ---
if pgrep -f "lightpanda mcp" >/dev/null 2>&1; then
  echo "lightpanda: already running"
else
  LP_BIN="$(command -v lightpanda || true)"
  if [ -z "$LP_BIN" ]; then
    echo "lightpanda: binary not found, install with: brew install lightpanda-io/browser/lightpanda" >&2
    exit 1
  fi
  # Render the template with this machine's paths (idempotent: re-renders
  # every start so a template change takes effect on the next start).
  sed -e "s|__LIGHTPANDA_BIN__|$LP_BIN|g" -e "s|__LOG_DIR__|$HOME/Library/Logs|g" "$LP_TEMPLATE" > "$LP_PLIST"
  plutil -lint "$LP_PLIST" >/dev/null
  bootstrap_agent "$LP_LABEL" "$LP_PLIST"
  # launchd starts it asynchronously; give it a moment, then verify.
  sleep 2
  if pgrep -f "lightpanda mcp" >/dev/null 2>&1; then
    echo "lightpanda: started (port 8931, logs in ~/Library/Logs/lightpanda.*.log)"
  else
    echo "lightpanda: failed to start, see ~/Library/Logs/lightpanda.err.log" >&2
    exit 1
  fi
fi
