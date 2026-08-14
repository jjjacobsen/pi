# Headless browser extension (pi-browser)

## Goal

Give the pi coding agent a real, persistent headless browser, built in house,
with the browser logic written in Zig. No third-party pi extensions involved.

## Architecture

```
pi (coding agent)
  └─ extensions/browser.ts     TS glue: tool schemas + stdio bridge
       └─ src/browser.zig      Zig backend: session owner, MCP client
            └─ lightpanda mcp  Lightpanda browser process (spawned, stdio)
```

Why this split:

- pi extensions must be TypeScript modules that pi loads and calls. There is
  no way around the TS entry point, but it can be thin: spawn a process, pipe
  JSON, register tools.
- Everything else lives in Zig (`src/browser.zig`). It owns the browser
  process lifecycle, the MCP session, error handling, and result extraction.
  Future logic (post-processing) grows in Zig.
- Wire protocol to the browser is **MCP over stdio** (JSON-RPC 2.0,
  newline-delimited). Lightpanda's MCP server exposes the full interaction
  surface: navigation, extraction (markdown/html/tree/links), interaction
  (click/fill/press/scroll/hover/select/check), JS evaluate, waits,
  structured data, cookies, console logs, and web search.
- CDP (`lightpanda serve`) was the alternative. CDP (Chrome DevTools
  Protocol) is the remote-control language Chromium-based browsers speak.
  Its channel is WebSocket (RFC 6455), which Zig's stdlib (0.16) does not
  implement, so talking CDP would mean hand-rolling the wire protocol
  (handshake, frame parsing, payload masking, ping/pong), roughly 300-500
  lines of byte-level code. MCP covers the interaction surface with a
  trivial protocol, so we chose MCP. CDP is not an upgrade path: lightpanda
  has no graphical rendering engine, so `Page.captureScreenshot` returns a
  placeholder image. Vision is out of scope for this extension.

## Protocols

### pi glue -> Zig backend (one JSON object per line on stdin)

```json
{"id":1,"tool":"goto","params":"{\"url\":\"https://example.com\"}"}
```

`params` is a JSON **string** containing a raw JSON object, so Zig never has
to serialize JSON. Tool names and argument names are Lightpanda MCP names
(see the tools/list output). The glue owns the name mapping and schemas.

### Zig backend -> pi glue (one JSON object per line on stdout)

```json
{"id":1,"ok":true,"result":"..."}
{"id":1,"ok":false,"error":"..."}
```

`result` is the text extracted from the MCP `tools/call` response (content
array of text items, or the raw string fallback).

### Zig backend -> lightpanda mcp

Standard MCP over stdio: `initialize` (protocolVersion 2024-11-05),
`notifications/initialized`, then `tools/call` per request. Responses are
matched by id; unrelated notifications are skipped.

## Zig implementation notes (Zig 0.16)

- Only `std.posix` is used for IO (read/write/signals) plus
  `std.process.spawn` for the child. `std.posix` in 0.16 no longer has
  fork/exec/pipe/dup2; `std.process.spawn` with `.stdin = .pipe`,
  `.stdout = .pipe` is the supported path and returns `Io.File` objects.
- `std.Io.File.writer` buffers; call `flush()` after writes or the bytes
  never leave the process.
- Line reading is manual (posix.read into a growing buffer) because the new
  Io.Reader API lacks `readUntilDelimiterOrEof`.
- lightpanda mcp **ignores SIGTERM** and only exits on stdin EOF. Cleanup
  therefore closes the child's stdin pipe first, then `child.kill` (which
  signals and reaps). Null `child.stdin` after closing to avoid a double
  close in its cleanup.
- The child process's stderr is **piped**, not inherited: a background
  thread drains it and forwards only `$level=error` / `$level=fatal` log
  lines to pi's stderr. Everything below error is dropped — pages drive
  warn/info noise (websocket reconnects, `console.*` calls) that lightpanda
  logs by default and that would otherwise flood the TUI. To see full
  lightpanda logs, run `lightpanda mcp --log-level debug` manually.
- lightpanda applies its HTTP transfer timeout to WebSocket connections and
  never resets it after the upgrade, so with the default 5s cap, idle
  persistent sockets (webpack HMR, Supabase Realtime, ...) die every 5
  seconds, pages auto-reconnect in an endless loop, and each disconnect
  logs a warn. We spawn lightpanda with `--http-timeout 0` so websockets
  stay connected, and bound every MCP tool call ourselves with
  `CALL_TIMEOUT_MS` (120s, enforced via `posix.poll` in `readLine`) so a
  stalled transfer cannot hang the backend forever. Lightpanda's own
  tool-level timeouts (navigation 10s, waits 5s, evaluate 30s) are far
  shorter and unaffected.
- The main loop reads requests from our own stdin (fd 0); the Browser's
  line reader is used for the child's stdout only.

## Self-check

`zig build run -- --self-check` spawns lightpanda, handshakes, fetches
https://example.com as markdown, and asserts "Example Domain" appears. This
exercises the whole stack and is the gate for `mise check`.

## Known limitations and upgrade paths

- **No screenshots, by design**: lightpanda has no graphical rendering
  engine, so there are no pixels to capture. `Page.captureScreenshot`
  returns a placeholder image and MCP is text-only, so this extension is
  deliberately text-based. A workflow that needs real screenshots or vision
  requires a different browser engine (e.g., Chromium), not an addition to
  this one.
- **Session is per-process**: the loaded page lives in the `lightpanda mcp`
  process spawned by this backend. `lightpanda mcp` supports sessions
  (session_new/list/close) and script saving (`save`, PandaScript); the
  glue does not expose them yet.
- **/reload**: pi reloading extensions may leave the old backend process
  alive if pi keeps the pipe fds open. Harmless (idle), cleaned up when pi
  exits and the pipe closes.
- **Lightpanda is early-stage**: its own JS engine is not Chromium-complete;
  heavy sites may misrender. Lightpanda nightly is installed via
  `brew install lightpanda-io/browser/lightpanda`.
- **Possible future: build Lightpanda from source as a git submodule** of this
  repo instead of relying on the brew nightly. This would pin the exact
  browser version our extension is tested against and allow local patches.
  Add the submodule under e.g. `third_party/lightpanda` and build it with a
  mise task; the Zig backend would prefer the locally built binary over
  `lightpanda` from PATH.
- **MAX_LINE cap**: single messages over 64MB fail with LineTooLong.
