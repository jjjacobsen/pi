#!/usr/bin/env bash
# Start the persistent daemons the pi extensions talk to, but only the ones
# that are not running:
#   lightpanda  the headless browser daemon behind the browser_* tools
#   CuaDriver   the desktop automation daemon behind the computer_* tools
#
# Both run as launchd LaunchAgents so they survive reboots and are restarted
# by launchd if they crash. The plists are rendered from the templates in
# scripts/ into ~/Library/LaunchAgents on demand with this machine's paths,
# so a second computer just needs lightpanda installed
# (brew install lightpanda-io/browser/lightpanda) and CuaDriver.app
# installed (https://github.com/trycua/cua), then this task run once.
#
# Uninstall: launchctl bootout gui/$(id -u)/<label> and delete the matching
# ~/Library/LaunchAgents plist.
set -euo pipefail

LP_LABEL=com.pijon.lightpanda
LP_PLIST="$HOME/Library/LaunchAgents/$LP_LABEL.plist"
CUA_LABEL=com.trycua.cua-driver
CUA_PLIST="$HOME/Library/LaunchAgents/$CUA_LABEL.plist"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LP_TEMPLATE="$REPO_DIR/scripts/$LP_LABEL.plist"
CUA_TEMPLATE="$REPO_DIR/scripts/$CUA_LABEL.plist"

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

# --- CuaDriver (desktop automation) ---
if pgrep -f "cua-driver serve" >/dev/null 2>&1; then
  echo "CuaDriver: already running"
else
  CUA_BIN="/Applications/CuaDriver.app/Contents/MacOS/cua-driver"
  if [ ! -x "$CUA_BIN" ]; then
    echo "CuaDriver: binary not found at $CUA_BIN, install from https://github.com/trycua/cua" >&2
    exit 1
  fi
  # Render the vendor template
  # (https://cua.ai/docs/how-to-guides/driver/keep-running) with this
  # machine's log dir.
  sed -e "s|__LOG_DIR__|$HOME/Library/Logs|g" "$CUA_TEMPLATE" > "$CUA_PLIST"
  plutil -lint "$CUA_PLIST" >/dev/null
  bootstrap_agent "$CUA_LABEL" "$CUA_PLIST"
  sleep 2
  if pgrep -f "cua-driver serve" >/dev/null 2>&1; then
    echo "CuaDriver: started (logs in ~/Library/Logs/cua-driver.*.log)"
  else
    echo "CuaDriver: failed to start, see ~/Library/Logs/cua-driver.err.log" >&2
    exit 1
  fi
fi
