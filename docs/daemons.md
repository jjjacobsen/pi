# Daemons (lightpanda, CuaDriver)

The browser and computer-use extensions do not manage the tools they drive.
Instead they talk to long-lived daemons that this repo starts for you:

| Daemon | Drives | Extension | Started by |
|---|---|---|---|
| `lightpanda mcp` | the browser_* tools (pi-lightpanda) | launchd LaunchAgent | `mise run daemon-start` |
| `cua-driver serve` | the computer_* tools (pi-cua) | launchd LaunchAgent | `mise run daemon-start` |

Both daemons are per-machine: they hold state (the browser page, the
desktop session) that a one-shot extension process cannot own. The
extensions are stateless one-shot binaries that POST a request to the local
daemon and exit.

## Tasks

```bash
mise run daemon-status    # report which daemons are up; exit 1 when any is down
mise run daemon-start     # start only the daemons that are not running
mise run daemon-restart   # restart both daemons to pick up updated binaries
```

`daemon-start` is smart per daemon: if one is running it is skipped, if one
is down only that one is (re)started. It is idempotent, safe to run any
time, and failing to start a daemon aborts the task with exit 1.

`daemon-restart` is for after updates: a running daemon keeps executing
the old binary from memory, so `brew upgrade lightpanda` or
`cua-driver update --apply` does not take effect until the daemon
restarts. The task boots both LaunchAgents out (stopping the daemons),
kills any CuaDriver instance started manually outside launchd, then runs
`daemon-start`. Restarting lightpanda wipes every browser session, so the
next `browser_*` call fails with "no page is loaded" until you navigate
again.

## lightpanda (headless browser)

The browser daemon is `lightpanda mcp --port 8931 --host 127.0.0.1
--http-timeout 0`, run as a launchd LaunchAgent. The extension (pi-lightpanda)
POSTs one MCP tools/call (JSON-RPC 2.0 over HTTP) to
`http://127.0.0.1:8931/mcp` with a session id in the header
`Mcp-Session-Id`, defaulting to the shared `pi-main` tab, so a page stays
loaded between calls. No MCP initialize handshake is sent: lightpanda
accepts tools/call directly and creates the session on first use.

Session ids are client-chosen names. The default `pi-main` is shared by
every pi process, so they see one tab. A pi process can be pointed at its
own tab by the model via `browser_pick_session`, tabs can be listed with
`browser_sessions`, and released with `browser_close_session` (a closed
session is re-created empty on its next use, so close then use to reset a
tab). All tabs live inside the single lightpanda process.

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
- Update: `brew upgrade lightpanda`, then `mise run daemon-restart` so the
  daemon picks up the new binary.
- To stop it: `launchctl bootout gui/$(id -u)/com.pijon.lightpanda`. To
  uninstall: bootout, then delete
  `~/Library/LaunchAgents/com.pijon.lightpanda.plist`.

### Behavior notes

- The default shared page survives pi quitting, reloading, and restarting.
  Session `pi-main` lives in the daemon, so a resumed pi session finds the
  same page. A pi process that picked its own tab keeps that tab for the
  rest of the process (the choice resets on a pi reload).
- A fresh page appears only when the daemon restarts (reboot, crash
  restart, or `mise run daemon-restart`): every session is gone and the next call is
  routed into a new empty session, which fails with "no page is loaded"
  until the model navigates again.
- All tabs live in the one daemon process, so the resource footprint is
  bounded: N tabs means N pages inside a single lightpanda process, visible
  via `browser_sessions` and releasable via `browser_close_session`.
- Two pi instances on the same machine share the daemon and, unless told
  otherwise, the shared `pi-main` tab. Each can pick its own tab with
  `browser_pick_session` when isolation is wanted.
- Esc during a browser call kills only the one-shot client. The in-flight
  MCP call keeps running server-side (bounded by lightpanda's own tool
  timeouts, ~30s worst case) and the next call queues behind it.

## CuaDriver (desktop automation)

The desktop daemon is CuaDriver.app running its `serve` mode, managed as a
launchd LaunchAgent exactly like lightpanda. The plist follows the vendor's
own autostart guide
(https://cua.ai/docs/how-to-guides/driver/keep-running): it execs
`/Applications/CuaDriver.app/Contents/MacOS/cua-driver serve` directly, so
the daemon is attributed to `com.trycua.driver` and the Accessibility and
Screen Recording grants persist across reboots. A daemon started from a
terminal prompt is attributed to the terminal instead, and the grants do
not apply to it. The extension (pi-cua) spawns `cua-driver call <tool>
<json-args>` per request, a CLI proxy to the daemon. Requires macOS
permissions: Accessibility and Screen Recording, granted once in System
Settings (or `cua-driver permissions grant`). Install from
https://github.com/trycua/cua.

The plist is rendered from `scripts/com.trycua.cua-driver.plist` into
`~/Library/LaunchAgents/com.trycua.cua-driver.plist` by `daemon-start`,
with the vendor's label and KeepAlive. launchd starts it at login
(RunAtLoad) and restarts it on any exit. Logs:
`~/Library/Logs/cua-driver.log` and `~/Library/Logs/cua-driver.err.log`.

- Update: `cua-driver update --apply` (the CLI's canonical installer),
  then `mise run daemon-restart` so the daemon picks up the new binary.
- To stop it: `launchctl bootout gui/$(id -u)/com.trycua.cua-driver`. To
  uninstall: bootout, then delete
  `~/Library/LaunchAgents/com.trycua.cua-driver.plist`.

## Setup on a different computer

1. Install lightpanda: `brew install lightpanda-io/browser/lightpanda`
2. Install CuaDriver.app from https://github.com/trycua/cua, grant
   Accessibility and Screen Recording in System Settings
3. In the repo root run `mise install` to install the pinned tools (zig, hk, ...) from `mise.toml`
4. `mise run daemon-start` — installs the LaunchAgent, starts lightpanda
   and CuaDriver
5. `mise run daemon-status` to confirm both are running

The port 8931 is a constant in two places: `src/lightpanda.zig` (DAEMON_PORT)
and `scripts/com.pijon.lightpanda.plist`. If it ever needs to change, edit
both and re-run `mise run daemon-start` (it re-renders the plist).
