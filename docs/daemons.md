# Daemon (lightpanda)

The browser extension does not manage the browser process it drives. It talks
to a long-lived `lightpanda mcp` daemon that this repo starts as a launchd
LaunchAgent. The extension stays a stateless one-shot binary that posts one
request to the local daemon and exits

## Tasks

```bash
mise run daemon-status    # report whether lightpanda is up
mise run daemon-start     # start lightpanda when it is not running
mise run daemon-restart   # restart lightpanda after an update
```

`daemon-start` is idempotent and safe to run at any time. `daemon-restart` is
for use after `brew upgrade lightpanda`, because a running daemon keeps the old
binary in memory

## lightpanda

The daemon is `lightpanda mcp --port 8931 --host 127.0.0.1 --http-timeout 0`,
run as a launchd LaunchAgent. The pi-lightpanda extension posts one MCP
`tools/call` request to `http://127.0.0.1:8931/mcp` with a session ID in the
`Mcp-Session-Id` header. The default ID is the shared `pi-main` tab, so a page
stays loaded between calls. Lightpanda accepts `tools/call` directly and
creates the session on first use, so no MCP initialize handshake is sent

Session IDs are client-chosen names. Every pi process shares `pi-main` by
default. A process can use its own tab with `browser_pick_session`. Use
`browser_sessions` to list tabs and `browser_close_session` to release one. A
closed session is created empty on its next use

- `--http-timeout 0` prevents idle persistent sockets from being closed
- `daemon-start` renders `scripts/com.pijon.lightpanda.plist` into
  `~/Library/LaunchAgents/com.pijon.lightpanda.plist` with the installed
  lightpanda path
- launchd starts the daemon at login and restarts it after a failed exit
- Logs are in `~/Library/Logs/lightpanda.log` and
  `~/Library/Logs/lightpanda.err.log`
- Update with `brew upgrade lightpanda`, then run `mise run daemon-restart`
- Stop with `launchctl bootout gui/$(id -u)/com.pijon.lightpanda`
- Uninstall the LaunchAgent by stopping it and deleting
  `~/Library/LaunchAgents/com.pijon.lightpanda.plist`

## Behavior notes

- The shared page survives pi quit, reload, and restart
- Restarting lightpanda removes every browser session. The next browser call
  fails with "no page is loaded" until you navigate again
- All tabs live in one daemon process and can be listed and released
- Esc during a browser call kills only the one-shot client. The daemon call
  continues within lightpanda's tool timeout, and the next call waits behind it

Port 8931 is set in `src/lightpanda.zig` and
`scripts/com.pijon.lightpanda.plist`. Change both, then run
`mise run daemon-start` to render the updated plist
