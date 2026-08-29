#!/usr/bin/env bash
# Report whether the lightpanda daemon behind the browser_* tools is running
# Exit status: 0 when it is up, 1 when it is down

if pgrep -f "lightpanda mcp" >/dev/null 2>&1; then
  echo "lightpanda: running"
  exit 0
fi

echo "lightpanda: STOPPED (start with: mise run daemon-start)"
exit 1
