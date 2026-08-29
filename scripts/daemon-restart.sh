#!/usr/bin/env bash
# Restart the persistent lightpanda daemon behind the browser_* tools so it
# picks up a freshly installed binary
#
# Run after `brew upgrade lightpanda`: the running process keeps executing the
# old binary from memory until it restarts
#
# Restarting lightpanda wipes all browser sessions. The next browser_* call
# fails with "no page is loaded" until you navigate again
set -euo pipefail

UID_NUM="$(id -u)"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

launchctl bootout gui/$UID_NUM/com.pijon.lightpanda >/dev/null 2>&1 || true

exec bash "$REPO_DIR/scripts/daemon-start.sh"
