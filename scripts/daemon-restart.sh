#!/usr/bin/env bash
# Restart the persistent daemons the pi extensions talk to, so they pick up
# freshly installed binaries:
#   lightpanda  the headless browser daemon behind the browser_* tools
#   CuaDriver   the desktop automation daemon behind the computer_* tools
#
# Run after updating either daemon (brew upgrade lightpanda, or
# cua-driver update --apply): the running process keeps executing the old
# binary from memory until it restarts. This boots both launchd agents out
# (stopping the daemons), kills any CuaDriver instance that was started
# manually outside launchd, then runs daemon-start to bring everything back
# up on the installed binaries.
#
# Note: restarting lightpanda wipes all browser sessions (tabs). The next
# browser_* call fails with "no page is loaded" until you navigate again.
set -euo pipefail

UID_NUM="$(id -u)"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Unload both agents (stops the daemons); ignore errors when not loaded.
launchctl bootout gui/$UID_NUM/com.pijon.lightpanda >/dev/null 2>&1 || true
launchctl bootout gui/$UID_NUM/com.trycua.cua-driver >/dev/null 2>&1 || true

# Kill a CuaDriver daemon that was started manually (open -a CuaDriver)
# outside launchd, so it cannot survive the restart.
pkill -f "cua-driver serve" >/dev/null 2>&1 || true

exec bash "$REPO_DIR/scripts/daemon-start.sh"
