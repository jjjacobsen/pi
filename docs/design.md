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
  Future logic (post-processing, screenshots via CDP) grows in Zig.
- Wire protocol to the browser is **MCP over stdio** (JSON-RPC 2.0,
  newline-delimited). Lightpanda's MCP server exposes the full interaction
  surface: navigation, extraction (markdown/html/tree/links), interaction
  (click/fill/press/scroll/hover/select/check), JS evaluate, waits,
  structured data, cookies, console logs, and web search.
- CDP (`lightpanda serve --cdp-port`) was the alternative. CDP (Chrome
  DevTools Protocol) is the remote-control language Chromium-based browsers
  speak: a set of JSON commands like "capture a screenshot" or "run this
  JavaScript", with the browser also pushing messages at any time (page
  loaded, console line, network event). That push behavior needs a
  persistent two-way channel, and CDP's channel is WebSocket (RFC 6455).
  Zig's stdlib (0.16) has no WebSocket client, so talking CDP means
  implementing the WebSocket wire protocol ourselves (handshake, frame
  parsing, payload masking, ping/pong), roughly 300-500 lines of byte-level
  code. MCP covers the interaction surface with a trivial protocol, so we
  chose MCP. Add a CDP client in Zig later if screenshots become necessary.

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
- The child process's stderr is inherited, so lightpanda logs land in pi's
  stderr. Run with `LP_*` env vars or `--log-level` as needed.
- The main loop reads requests from our own stdin (fd 0); the Browser's
  line reader is used for the child's stdout only.

## Self-check

`zig build run -- --self-check` spawns lightpanda, handshakes, fetches
https://example.com as markdown, and asserts "Example Domain" appears. This
exercises the whole stack and is the gate for `mise check`.

## Known limitations and upgrade paths

- **No screenshots**: MCP is text-only, and screenshots are the one thing
  CDP gives us that MCP does not. When screenshots matter, add a Zig CDP
  client against `lightpanda serve --cdp-port`. That means speaking
  WebSocket, either hand-rolled RFC 6455 in Zig (see the architecture
  section above) or, as an escape hatch, letting a JS WebSocket library
  handle it from the glue side instead of Zig.
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
- **MAX_LINE cap**: single messages over 64MB fail with LineTooLong.
