# Daemons (lightpanda, CuaDriver)

The browser and computer-use extensions do not manage the tools they drive.
Instead they talk to long-lived daemons that this repo starts for you:

| Daemon | Drives | Extension | Started by |
|---|---|---|---|
| `lightpanda mcp` | the browser_* tools (pi-browser) | launchd LaunchAgent | `mise run daemon-start` |
| CuaDriver.app | the computer_* tools (pi-cua) | `open -n -g -a CuaDriver --args serve` | `mise run daemon-start` |

Both daemons are per-machine: they hold state (the browser page, the
desktop session) that a one-shot extension process cannot own. The
extensions are stateless one-shot binaries that POST a request to the local
daemon and exit.

## Tasks

```bash
mise run daemon-status   # report which daemons are up; exit 1 when any is down
mise run daemon-start    # start only the daemons that are not running
```

`daemon-start` is smart per daemon: if one is running it is skipped, if one
is down only that one is (re)started. It is idempotent, safe to run any
time, and failing to start a daemon aborts the task with exit 1.

## lightpanda (headless browser)

The browser daemon is `lightpanda mcp --port 8931 --host 127.0.0.1
--http-timeout 0`, run as a launchd LaunchAgent. The extension (pi-browser)
POSTs one MCP tools/call (JSON-RPC 2.0 over HTTP) to
`http://127.0.0.1:8931/mcp` with the session header `Mcp-Session-Id:
pi-main`, and every call attaches to that same session, so the page stays
loaded between calls. No MCP initialize handshake is sent: lightpanda
accepts tools/call directly and creates the session on first use.

- `--http-timeout 0` disables lightpanda's HTTP transfer timeout. It is
  applied to WebSocket connections too and would otherwise kill idle
  persistent sockets (webpack HMR, Supabase Realtime) every few seconds.
- The LaunchAgent plist is rendered from
  `scripts/com.pijon.lightpanda.plist` into
  `~/Library/LaunchAgents/com.pijon.lightpanda.plist` by `daemon-start`,
  with this machine's `lightpanda` binary path substituted.
- launchd restarts the daemon if it crashes (KeepAlive on non-successful
  exit) and starts it at login. Logs: `~/Library/Logs/lightpanda.log` and
  `~/Library/Logs/lightpanda.err.log`.
- When the daemon is down, browser tools fail with a clear error naming
  `mise run daemon-start` as the fix.
- To stop it: `launchctl bootout gui/$(id -u)/com.pijon.lightpanda`. To
  uninstall: bootout, then delete
  `~/Library/LaunchAgents/com.pijon.lightpanda.plist`.

### Behavior notes

- The page survives pi quitting, reloading, and restarting. Session
  `pi-main` lives in the daemon, so a resumed pi session finds the same
  page.
- A fresh page appears only when the daemon restarts (reboot, crash
  restart, manual bootout): the old session is gone and the next call is
  routed into a new empty session, which fails with "no page is loaded"
  until the model navigates again.
- Two pi instances on the same machine share the daemon and therefore the
  same single tab. Known limitation, accepted for now.
- Esc during a browser call kills only the one-shot client. The in-flight
  MCP call keeps running server-side (bounded by lightpanda's own tool
  timeouts, ~30s worst case) and the next call queues behind it.

## CuaDriver (desktop automation)

The desktop daemon is the CuaDriver.app application running with `serve`
as its argument. The extension (pi-cua) spawns `cua-driver call <tool>
<json-args>` per request, a CLI proxy to the daemon. Requires macOS
permissions: Accessibility and Screen Recording, granted once in System
Settings. Install from https://github.com/trycua/cua.

`daemon-start` detects it by its process name (`cua-driver serve`) and
starts it with the same command used manually:
`open -n -g -a CuaDriver --args serve`.

## Setup on a different computer

1. Install lightpanda: `brew install lightpanda-io/browser/lightpanda`
2. Install CuaDriver.app from https://github.com/trycua/cua, grant
   Accessibility and Screen Recording in System Settings
3. In the repo root run `mise install` to install the pinned tools (zig, hk, ...) from `mise.toml`
4. `mise run daemon-start` — installs the LaunchAgent, starts lightpanda
   and CuaDriver
5. `mise run daemon-status` to confirm both are running

The port 8931 is a constant in two places: `src/browser.zig` (DAEMON_PORT)
and `scripts/com.pijon.lightpanda.plist`. If it ever needs to change, edit
both and re-run `mise run daemon-start` (it re-renders the plist).
