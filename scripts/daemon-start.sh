#!/usr/bin/env bash
# Start the persistent daemons the pi extensions talk to, but only the ones
# that are not running:
#   lightpanda  the headless browser daemon behind the browser_* tools
#   CuaDriver   the desktop automation daemon behind the computer_* tools
#
# lightpanda runs as a launchd LaunchAgent so it survives reboots and is
# restarted by launchd if it crashes. The plist is rendered from
# scripts/com.pijon.lightpanda.plist into ~/Library/LaunchAgents on demand
# with this machine's lightpanda path, so a second computer just needs
# lightpanda installed (brew install lightpanda-io/browser/lightpanda) and
# this task run once.
#
# Uninstall: launchctl bootout gui/$(id -u)/com.pijon.lightpanda and delete
# ~/Library/LaunchAgents/com.pijon.lightpanda.plist.
set -euo pipefail

LP_LABEL=com.pijon.lightpanda
LP_PLIST="$HOME/Library/LaunchAgents/$LP_LABEL.plist"
LP_REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LP_TEMPLATE="$LP_REPO_DIR/scripts/$LP_LABEL.plist"

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
  # Bootstrap, handling the case where the agent is already loaded but the
  # process is dead: bootout, then bootstrap fresh.
  launchctl bootstrap gui/$(id -u) "$LP_PLIST" 2>/dev/null \
    || { launchctl bootout gui/$(id -u)/$LP_LABEL >/dev/null 2>&1 || true; launchctl bootstrap gui/$(id -u) "$LP_PLIST"; }
  # launchd starts it asynchronously; give it a moment, then verify.
  sleep 2
  if pgrep -f "lightpanda mcp" >/dev/null 2>&1; then
    echo "lightpanda: started (port 8931, logs in ~/Library/Logs/lightpanda.*.log)"
  else
    echo "lightpanda: failed to start, see ~/Library/Logs/lightpanda.err.log" >&2
    exit 1
  fi
fi

# --- CuaDriver (desktop automation) ---
if pgrep -f "cua-driver serve" >/dev/null 2>&1; then
  echo "CuaDriver: already running"
else
  open -n -g -a CuaDriver --args serve
  sleep 2
  if pgrep -f "cua-driver serve" >/dev/null 2>&1; then
    echo "CuaDriver: started"
  else
    echo "CuaDriver: failed to start, check the app is installed and Accessibility/Screen Recording are granted" >&2
    exit 1
  fi
fi
