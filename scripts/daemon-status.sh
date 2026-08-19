#!/usr/bin/env bash
# Report which daemons the pi extensions rely on are running:
#   lightpanda  the headless browser daemon behind the browser_* tools
#   CuaDriver   the desktop automation daemon behind the computer_* tools
# Exit status: 0 when all are up, 1 when any is down (handy for scripting).
status=0

if pgrep -f "lightpanda mcp" >/dev/null 2>&1; then
  echo "lightpanda: running"
else
  echo "lightpanda: STOPPED (start with: mise run daemon-start)"
  status=1
fi

if pgrep -f "cua-driver serve" >/dev/null 2>&1; then
  echo "CuaDriver: running"
else
  echo "CuaDriver: STOPPED (start with: mise run daemon-start)"
  status=1
fi

exit $status
