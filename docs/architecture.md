# Shared code (pi-common / pi-backends)

Extensions are one-shot: the glue spawns the Zig binary per call with the
request as a single JSON argv element (`pi.exec`), the binary prints one
JSON envelope to stdout, and exits. No persistent processes, no stdio
bridge, no lifecycle management. Fault tolerance is unchanged: a crash in
the binary cannot take down pi. The shared parts live in two files:

- `src/common.zig`: IO, JSON, and process helpers used by every backend —
  the one-shot responders (`respondExit` / `respondOutcomeExit`, which
  print the `{"ok":true,"result":...}` envelope and exit 0/1), buffered
  writer (`writeAllIo`), JSON-escaped writer helper (`appendJsonEscaped`),
  monotonic and realtime clocks (`nowMs` / `nowRealtimeMs`), and the
  command runner (`runCmd`, `gitRoot`, `GitResult`). Since pi-search and
  pi-vision were built, it also holds the HTTP-with-deadline machinery
  they share (`httpWithDeadline`, `WorkerSlot`, `workerFinish`,
  `isRetryableStatus` / `isRetryableErr`, `parseHeaders`): each backend
  keeps its own fetch worker and response parsing, and the worker-slot
  lifecycle (socket shutdown on deadline, abandoned-worker self-cleanup
  when a worker is stuck before registering its socket) lives once. Each
  backend aliases only what it needs and keeps its own request parsing,
  op dispatch, and protocol structs. `goal.zig` aliases
  `nowRealtimeMs` because its deadlines must be comparable to the glue's
  wall time; the others use the monotonic clock. The old id-based
  `respond` / `respondOutcome` and the line reader (`readLine`) remain for
  the persistent backends (browser last) and die with them.
- `extensions/lib/zig.ts`: `callZig(pi, binaryName, params, {signal,
  timeout})` runs one backend op. It resolves the binary path (fails with
  a rebuild hint when missing), spawns the binary via `pi.exec` with the
  request as one JSON argv element, parses the stdout envelope, and
  throws on a killed process (abort or timeout), a crash (non-zero exit
  without an envelope), or a protocol error (`ok:false`).

The persistent bridge (`extensions/lib/backend.ts`, `createBackend` +
`handleSessionShutdown`) is the pre-one-shot model, kept only for the
unconverted backends (browser last). It owns lazy spawning, the
pending-call map, line dispatch, `restart()` / `reset()` / `kill()` on
session boundaries, and the unref dance; unconverted backends still
register `pi.on("session_shutdown", ...)`. The conversion playbook lives
in `skills/convert-extension/SKILL.md`.

Per-backend protocol details are documented in each extension's section
below; the wire format is identical everywhere: one JSON request line on
stdin, one JSON response line on stdout.

# TypeScript glue tooling (tsconfig, tsc, hk)

The extension glue imports `@earendil-works/pi-*` (pi-coding-agent, pi-tui,
pi-ai) and `typebox`, which live only in bun's global install at
`~/.bun/install/global/node_modules`, not in this repo. Pi resolves them at
runtime by aliasing them to its own bundled copies inside its extension
loader, so the repo needs no local install for the extensions to work.

The editor typechecker does need them, so `tsconfig.json` points at the
live global install instead of a local `node_modules`:

- `paths` maps `@earendil-works/pi-ai/*` into the package's `dist/`
  (subpath exports like `@earendil-works/pi-ai/compat` live there and
  `paths` does not consult the target package's `exports` map), and maps
  every other `@earendil-works/*` specifier plus `typebox` to their
  packages. These paths are absolute and machine-specific.
- `typeRoots` points at the global `@types` dir so `node:*` builtins and
  the `types: ["node"]` entry resolve without installing `@types/node`.
- `strict: false` is explicit because TypeScript 6.0 flips strict on by
  default, and this glue is deliberately un-annotated per the repo's
  conventions. TS 6.0 also no longer infers `never` for un-annotated
  throwing functions, which is why the shared helpers' return types are
  annotated (`toolError(...): never`).

Advantages of pointing at the live install: types always match the running
pi version (a `pi update` updates them automatically, no drift), and the
repo holds no pinned copies that could corrupt or drift from the real API.
The tradeoff is that the tsconfig breaks on any machine without a matching
global install, so it is not shareable as-is.

`hk.pkl` runs the `tsc` builtin (`tsc --noEmit -p tsconfig.json`) whenever a
`.ts` file or `tsconfig.json` changes, and `mise.toml` pins
`npm:typescript = "6.0.3"` so the check and the editor use the same
compiler. `mise x -- hk check --all` must stay green.

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
{"id":1,"op":"goto","params":"{\"url\":\"https://example.com\"}"}
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
  Io.Reader API lacks `readUntilDelimiterOrEof`. These helpers live in
  `src/common.zig` (see the shared-code section above).
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
- Extracted tool results are capped at 256KB with head/tail truncation
  ("… [N bytes truncated] …"), so one html/tree/evaluate call cannot flood
  the model's context or bloat the session file below the 64MB protocol
  limit.

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
- **Esc aborts an in-flight call**: browser tools use the shared `withAbort`
  path like vision/search, so Esc during a call that can wait 120s kills and
  respawns the backend. The loaded page is lost (the lightpanda process goes
  down with the backend), matching the abort semantics of the other
  HTTP-delegating tools.
- **/reload**: the glue rebuilds stale binaries and extensions kill their
  backend on `session_shutdown` when the host is torn down (quit or
  reload), so a reload after editing Zig or TS code runs the new build with
  no orphaned processes. In-flight backend calls during a reload fail fast
  ("backend killed"), which is intended: reload is terminal for the old
  instance. Session replacement (`/new`, `/resume`, `/fork`)
  resets the backend instead: pi reuses the loaded extension instances, so
  a terminal kill there would leave the new session permanently dead, and
  reset kills the child and respawns fresh, dropping the loaded page so no
  browsing state bleeds into the new session.
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

# Computer-use extension (pi-cua)

## Goal

Give the pi coding agent control of the host desktop through [Cua
Driver](https://github.com/trycua/cua) (`cua-driver` 0.20+): real apps,
signed-in browser sessions, and the current OS user session, without moving
the system cursor (each command targets a window instead of the shared
cursor). Screenshots are written to disk and viewed through the existing
describe_image vision tool, so the extension works with text-only primaries
and the model controls when vision tokens are spent.

## Architecture

```
pi (coding agent)
  └─ extensions/cua.ts     TS glue: 19 computer_* tool schemas + stdio bridge
       └─ src/cua.zig      Zig backend: spawns `cua-driver call` per request
            └─ cua-driver  CLI proxy to the CuaDriver daemon (CuaDriver.app on macOS)
```

Why this split:

- pi extensions must be TypeScript modules, so the glue registers the tool
  schemas (one per cua-driver MCP tool; params pass through as a JSON
  string, so the keys must match the MCP argument names) and bridges calls
  over the shared newline-delimited JSON pipe. Esc aborts by killing and
  respawning the backend (shared `withAbort`), so no driver call outlives
  its turn; the in-flight `cua-driver call` finishes on its own (it is a
  short-lived CLI that proxies to the daemon).
- Everything else is Zig: the argv build, the child lifecycle, the 120s
  deadline, stdout/stderr handling, the screenshot directory, and the
  get_window_state extraction.

## Protocol (newline-delimited JSON on stdin/stdout)

```json
{"id":1,"op":"call","tool":"get_window_state","params":"{\"pid\":123}"}  -> Zig
{"id":1,"ok":true,"result":"..."}                                            <- Zig
{"id":1,"ok":false,"error":"..."}                                           <- failures
```

`params` is a JSON string containing the raw arguments object (same shape
as pi-browser). The glue sends only op/tool/params.

## Zig behavior

- **One spawn per call**: `cua-driver call [--screenshot-out-file <path>]
  <tool> <params-json>`. The child's stdin is `.ignore` (a /dev/null open):
  cua-driver call reads stdin when it is piped, which would block forever
  on the backend's open pipe. stdout is drained to EOF (one JSON result
  line, pretty-printed; draining past the 64KB pipe buffer is what keeps a
  large elements array from deadlocking `wait`), stderr is drained on a
  background thread into a capped buffer (the thread is joined before the
  buffer is read or freed).
- **Result rules** (learned from the real CLI, verified against 0.20.0):
  - Non-empty stdout is the result, even when the payload is an in-band
    error like `{"code":"window_id_not_found",...}` or
    `invalid_arguments`: those are normal operational outcomes the model
    must see and recover from, so they pass through as results.
  - Empty stdout means the call failed: the stderr text is the error (e.g.
    "Permission denied: tool 'x' has no reviewed risk classification"),
    falling back to the exit term.
  - Exit codes are never used to judge success (invalid args exit 0).
  - The 120s default deadline is enforced via the
    shared poll-based readLine; on expiry the child is SIGTERMed and
    reaped (`child.kill` closes its pipes, which also unblocks the stderr
    thread). A missing binary surfaces "failed to spawn ...", not a hang.
- **Screenshots**: image tools (get_window_state, get_desktop_state, zoom)
  always get `--screenshot-out-file` pointing into
  `~/.pi/agent/cua-screenshots/` (shot-<millis>.png/.jpg). The response
  does NOT echo the path back (the docs claim `screenshot_file_path`, the
  real CLI omits it), so the backend tracks it: get_window_state gets it
  appended by the extraction, the other two get a `screenshot: <path>`
  prefix line. The dir is created on demand and pruned to the newest 25
  files per call.
- **get_window_state extraction**: the driver returns the AX tree twice
  (model-facing `tree_markdown` with `[element_index N]` tags plus a
  `structuredContent.elements` array of up to 2000 JSON rows, each carrying
  an `element_token` and an optional `selected` flag). The elements array
  is redundant bloat for the model and is dropped, but its tokens and
  selected flags are injected into the markdown rows (`[N] tok=...
  [selected]`) and the `snapshot_id` is surfaced, so every tree row is
  directly clickable via `element_token` or `element_index + snapshot_id`
  with no pixel math and no screenshot. The result also keeps what action
  selection needs: pid/window_id, element count, window bounds, screenshot
  path + dimensions, `degraded_reason`, background-input route statuses,
  and the escalation recommendation. A payload without `tree_markdown`
  (in-band errors) passes through raw.
- Result text is capped at 256KB with head/tail truncation (shared
  pattern with pi-browser), so a huge tree cannot flood the model's
  context or the session file.

## Flow

The model calls `computer_list_apps` / `computer_list_windows` to find a
target, `computer_get_window_state` for the AX tree + screenshot path
(re-snapshot every turn: indices and element_tokens go stale), and
`describe_image` on the screenshot path when pixels matter. Actions prefer
`element_token` / `element_index + snapshot_id` (AX path: works on
backgrounded windows, no focus steal); `x,y` pixel coordinates are
window-local screenshot pixels (top-left origin, 2x scale on retina) for
canvas/WebGL surfaces only. `computer_zoom` crops a region to a readable
JPEG for pixel work. The driver reports background-input constraints in
the snapshot; the model retries with `delivery_mode: "foreground"` when a
background attempt did not land.

## Notes

- The glue unrefs the backend child and its pipes (shared `createBackend`),
  registers `session_shutdown` to tear it down (kill on quit/reload, reset
  on session replacement, shared `handleSessionShutdown`), and the backend
  self-terminates on stdin EOF like the other backends.
- Requires the Cua Driver daemon running and macOS Accessibility + Screen
  Recording granted to CuaDriver.app (`cua-driver permissions status`).
  Standard permission mode is assumed; approval prompts surface as driver
  errors the model relays. The extension itself makes no external calls
  beyond the local daemon.
- Session labels are deliberately not managed: cua-driver falls back to
  the authenticated transport's implicit lifecycle session. Explicit
  `start_session`/`end_session` management is future work.
- Tool surface is the focused 19-tool observation/action loop; the other
  ~37 driver tools (browser_*, clipboard, recording, menus, ...) are
  deliberately not exposed. Add them per tool when needed.

# Commit extension (pi-commit)

## Goal

Replace the third-party pi-committer package with an in-house `/commit`
command: stage all changes, generate a good conventional commit message from
the current model, and commit. Fast, no background workers, no auto-triggers,
no config file.

## Architecture

```
pi (coding agent)
  └─ extensions/commit.ts      TS glue: /commit command, subagent model call
       └─ src/commit.zig       Zig backend: git analysis, validation, commit
```

Why this split:

- pi extensions must be TypeScript modules. The glue registers the `/commit`
  command, collects the session context tail, and calls the current model
  through the pi SDK (`createAgentSession`, thinking level `low`, no tools).
  This is the same pattern pi-committer used, and it is the only place the
  provider credentials are reachable.
- Zig owns everything git-related and all message judgment: the diff digest,
  repo style sampling, conventional-commit validation with retry feedback,
  and the commit itself. The model writes, the backend judges.

## Protocol (newline-delimited JSON on stdin/stdout)

```json
{"id":1,"op":"analyze","cwd":"/path"}                        -> Zig
{"id":1,"ok":true,"result":"<markdown context>","empty":false} <- Zig
{"id":2,"op":"validate","message":"feat(x): ...\n\n..."}     ->
{"id":2,"ok":true,"result":"ok"}                             <-
{"id":2,"ok":false,"error":"- problem\n- problem"}           <- problems feed the retry
{"id":3,"op":"commit","message":"..."}                       ->
{"id":3,"ok":true,"result":"<short-hash> <header>"}          <-
```

## Zig behavior

- `analyze` runs `git add -A` first: the working tree is snapshotted when
  `/commit` starts, so a later `commit` op commits exactly what the user saw.
  Then it collects `--name-status`, `--stat`, and the `-U3` diff (with `-M`
  for rename detection), the last 25 commit subjects, and AGENTS.md/CLAUDE.md
  lines mentioning commits. Small diffs (under 6KB) are passed raw; bigger
  ones become a digest: per-file hunk headers plus declaration-like changed
  lines, capped at 12KB. The whole context is capped at 24KB.
- `validate` enforces: Conventional Commits header (`type(scope)!: desc`,
  type allowlist, header <= 100 chars), no vague descriptions ("update
  files"), no diff noise in the message, and a substantive body (>= 50 chars,
  not a placeholder). Problems are returned as `- line` text so the glue can
  feed them back to the model for one retry.
- `commit` re-checks that something is staged, runs `git commit -F -` with
  the message on stdin, and returns `<short-hash> <header>`. Pre-commit hooks
  run as normal. The child's stdout and stderr are drained concurrently via
  `std.Io.File.MultiReader`, so a verbose pre-commit hook that fills stderr
  cannot deadlock the drain (reading one pipe to EOF before the other would).

## Flow

`/commit` -> analyze (stage + digest) -> model call (low thinking) ->
validate -> on failure one retry with the problems appended -> commit ->
notify `<hash> <header>`.

There is no deterministic fallback: if the model cannot produce a valid
message after the retry, the command fails loudly with the problems and the
last attempt. Dumb messages are the exact failure mode this extension exists
to fix.

## Known limitations and upgrade paths

- **No confirmation prompt**: the commit is created immediately, like Codex.
  The message can be wrong (the model infers intent from the diff plus the
  session tail); the body may occasionally state a wrong "why".
- **One commit per invocation**: no grouping of code/test/docs into separate
  commits. Add grouping later only if wanted.
- **The "why" is best-effort**: sources are the session context tail, the
  `/commit <args>` intent, and AGENTS.md guidance. A manual commit can state
  intent via args.
- **Model and thinking level are fixed**: session model, `low` thinking.
  Config knobs (model override, thinking level) are future work.

# Lazygit extension (pi-lg)

## Goal

Open lazygit full-screen over the pi TUI with `/lg`, exactly like
kdheepak/lazygit.nvim does over nvim: lazygit takes the whole terminal, quit
returns to pi. All process logic lives in Zig; the TS glue only owns the pi
TUI lifecycle, which only code inside the pi process can touch.

## Architecture

```
pi (coding agent)
  └─ extensions/lazygit.ts    TS glue: /lg command, TUI stop/start around run
       └─ src/lazygit.zig     Zig backend: validation, /dev/tty handoff, spawn+wait
            └─ lazygit        spawned with stdin/stdout/stderr = /dev/tty
```

Why this split:

- The TUI suspend/resume must run inside the pi process: `tui.stop()` restores
  the cooked terminal, `tui.start()` re-enters raw mode. Only the TS
  extension (loaded into pi) can do that, and only component factories
  receive the live TUI reference, so the glue uses `ctx.ui.custom()` to grab
  it. This is the same mechanism pi's built-in Ctrl+G (`app.editor.external`)
  uses, and the UX copies lazygit.nvim.
- Everything else is Zig: lazygit detection, git-repo validation, opening
  /dev/tty, spawning lazygit with the terminal as its stdio, and exit-status
  reporting. The backend's own stdin/stdout are pipes to the glue, so it
  cannot "inherit" the terminal; Zig 0.16 spawn's `.file` StdIo dup2's an
  arbitrary fd into the child, which is how /dev/tty reaches lazygit.

## Protocol (newline-delimited JSON on stdin/stdout)

```json
{"id":1,"op":"prepare","cwd":"/path"}                  -> Zig
{"id":1,"ok":true,"result":"/path/to/repo-root"}       <- prepare
{"id":2,"op":"run","cwd":"/path"}                      ->
{"id":2,"ok":true,"result":"exited 0"}                 <- run: exited N / signal N / stopped / unknown
{"id":N,"ok":false,"error":"..."}                      <- failures
```

## Zig behavior

- `prepare` runs before the TUI stops so common failures surface as a
  notification with no screen flicker: `lazygit --version` (PATH check) and
  `git -C <cwd> rev-parse --show-toplevel` (repo check). It returns the repo
  root. `run` gets the same cwd (absolute, resolved by the glue against
  `ctx.cwd`).
- `run` opens /dev/tty (the controlling terminal) and spawns lazygit with
  stdin/stdout/stderr pointing at it, cwd = the target. lazygit puts the
  terminal in raw mode itself, renders full-screen, and restores termios on
  clean exit. The backend blocks in `child.wait` and reports the term.
- No special signal handling is needed: while lazygit runs it owns the
  terminal in raw mode (ISIG off), so Ctrl+C / Ctrl+Z are lazygit key events,
  not signals to pi. Same exposure pi's external editor has.

## Flow

`/lg` -> resolve target (`ctx.cwd`, or `/lg <path>`) -> prepare (error =>
notify, no screen change) -> `tui.stop()` -> run (Zig spawns lazygit on the
terminal, waits) -> `tui.start()` + full redraw + close component -> notify
`lazygit exited N`.

## Known limitations and upgrade paths

- **Unix-only by design**: /dev/tty does not exist on Windows, so the run op
  cannot hand the console to lazygit there. pi itself already treats suspend
  and external editors as Unix features, and this extension follows the same
  line. Windows support (CONIN$/CONOUT$ handoff) is out of scope.
- **Brief TUI blink on late spawn failure**: if prepare passes but the spawn
  itself fails (e.g. lazygit removed between prepare and run), stop/start
  still wrap the call and the screen redraws once. Acceptable.
- **Orphaned lazygit if pi dies while it runs**: same as pi's external
  editor; lazygit keeps the terminal and pi's next start redraws over it.
- **Generalizable to other TUIs**: the same backend shape runs any TUI tool;
  a `tool` field on run (lazygit default) would cover jj, tig, etc. Not
  implemented (YAGNI).

# Goal extension (pi-goal)

## Goal

In-house `/goal` command: run the agent autonomously for long stretches and
step away from the computer. It asks questions only at start (if needed),
never midway, and it respects time and token boundaries ("run for at least an
hour", "use at least 1M tokens"). `--no-ask` removes even the start-time
questions for full automation.

## Architecture

```
pi (coding agent)
  └─ extensions/goal.ts     TS glue: /goal command, lifecycle wiring, persistence, UI
       └─ src/goal.zig      Zig backend: goal state machine, boundaries, prompts, tool validation
```

Why this split:

- The glue is the only code inside the pi process, so it owns the pi event
  wiring (`session_start`, `input`, `before_agent_start`, `agent_end`,
  `agent_settled`, compaction, `session_shutdown`), persistence (goal state
  in custom session entries, so it survives compaction and reload), and UI
  (status line, notifications).
- The backend owns every decision: what a goal is, when it continues, when it
  stops, what the model is told, and whether `goal_complete` /
  `goal_blocked` / `goal_wait` calls are valid. The glue never decides goal
  policy.

## Protocol (newline-delimited JSON on stdin/stdout)

```json
{"id":1,"op":"parse","args":"fix bug --min-time 1h"}             -> Zig
{"id":2,"op":"start","objective":"...","min_time":"1h",...}      ->
{"id":3,"op":"event","event":"agent_end","state":{...},...}      ->
{"id":4,"op":"complete","state":{...},"goal_id":"...","summary":"..."}
{"id":5,"op":"blocked","state":{...},"goal_id":"...","reason":"...","evidence":"...","repeated_turns":3}
{"id":6,"op":"wait","state":{...},"goal_id":"...","reason":"...","resume_after_ms":300000}
{"id":7,"op":"pause","state":{...}}
{"id":8,"op":"resume","state":{...},"max_time":"2h"}
{"id":9,"op":"clear","state":{...}}
{"id":10,"op":"status","state":{...}}
{"id":11,"op":"restore","state":{...},"tokens":12345}
```

Events (op `event`): `input` (user message), `agent_start` (may inject the
goal system prompt), `agent_end` (per-turn accounting and next-step
decision), `settled` (pi idle; dispatches the pending continuation or a due
wait deadline), `compact` (post-compaction resume). Responses carry
`action`: `none` (nothing to do), `continue` (store the continuation prompt),
`send` (deliver the prompt as a message now), `stop` (goal stopped, notify
with `text`), and for `agent_start` additionally `inject` (return the prompt
as a system-prompt addition).

## Zig behavior

- **Boundaries**: `--min-time` / `--max-time` (1h, 30m, 45s suffixes) and
  `--min-tokens` / `--max-tokens` (k/m suffixes). Floors make the goal keep
  going even when the model reports done early; ceilings stop it with
  `stop_cause` `time_limit` / `token_limit`. Token accounting subtracts the
  baseline captured at start from the glue's cumulative session tokens.
- **No-progress guard**: assistant output is fingerprinted (normalized text);
  three consecutive identical turns stop the goal with `stop_cause`
  `no_progress`. Any user input, tool call, or output change resets the
  counter.
- **Error tolerance**: a run ending in provider error (`stopReason`
  `error`), e.g. a transient rate limit or network failure, does not pause
  the goal. Consecutive errored runs are counted; the goal pauses with
  `stop_cause` `interruption` only after three in a row. Any successful run,
  user input, or resume resets the count, and the continuation prompt notes
  the error so the model re-checks state instead of assuming its last tool
  calls landed.
- **goal_complete**: stale-turn guard via the `goal_id` shown in the goal
  prompt; a second completion is rejected with "goal is complete, not
  active".
- **goal_blocked**: only accepted after the same blocker recurs for at least
  three consecutive goal turns (`repeated_turns >= 3`), sets status
  `blocked`. Resuming starts a fresh three-turn audit.
- **goal_wait**: quiet waiting for an external event; no polling. An optional
  `resume_after_ms` deadline (clamped to >= 10s) wakes the goal, or a
  non-goal wake message does.
- **--no-ask**: the goal prompt tells the model the user is unavailable, to
  make reasonable assumptions, and to never ask questions.

## Flow

`/goal <objective> [flags]` -> parse -> start -> inject the goal-mode system
prompt (objective, goal_id, rules) -> the agent works -> `agent_end` ->
backend decides: continue (repeat until the floors are satisfied; errored
runs count toward a 3-strike pause instead of stopping immediately), stop
(complete / blocked / ceiling / no progress / 3 consecutive errors), or send
(a follow-up prompt) -> `agent_settled` dispatches the pending continuation
or a due wait deadline -> `goal_complete` ends the loop -> status line and
notification.

## Notes

- The glue unrefs the backend child and its stdin/stdout so pi can exit in
  print mode and on shutdown; the backend self-terminates when stdin closes
  (EOF), so no orphans linger.
- Goal loops need an interactive session: print mode (`pi -p`) runs the
  command handler but never processes the follow-up prompt, so `/goal` in
  print mode is a no-op.
- Pi reloading extensions kills the old backend via `session_shutdown`
  (shared `handleSessionShutdown`), and the glue rebuilds stale binaries, so
  `/reload` runs current code with no orphaned processes. Session
  replacement (`/new`, `/resume`, `/fork`) resets the backend: pi reuses
  the loaded extension instances, so a terminal kill there would break
  every command in the new session, and instead the child is killed and
  respawned fresh so goal state stays session-scoped (restored from the
  new session's entries on `session_start`).

# Repo audit skill (pi-repo-audit)

## Goal

In-house replacement for the ponytail-audit skill of the third-party
ponytail extension (disabled in settings): a whole-repo improvement audit
that outputs ranked, concrete findings without applying anything.

## Design

- Lives in `skills/repo-audit/SKILL.md`, served to pi as a package skill via
  the `skills` entry in `package.json`. No extension glue or backend, the
  skill is pure instructions for the model.
- Kept from ponytail-audit: repo-wide scan, ranked one-line findings,
  `<tag> <what>. <replacement>. [path]` format, the `net: -<N> lines,
  -<M> deps possible` closer, and the cut/stdlib/native/yagni/shrink tags.
- Extended with general code audit dimensions: dup (DRY), dep (dependency
  hygiene), err (error handling), perf, sec, test, arch, doc.
- Two discipline rules beyond ponytail: every finding must be verified by
  reading the actual code and its usage (false positives are noise), and
  the report caps at 15 findings so it forces prioritization.
- Deliberate repo conventions (AGENTS.md) are never findings. Correctness
  and security are out of scope except as red flags spotted in passing.

# Peon extension (pi-peon)

## Goal

In-house replacement for the third-party pi-peon-ping extension: Warcraft
orc peon and human peasant voice lines on pi lifecycle events (session
start, task acknowledge, task complete, task error, rapid prompt spam).
Everything pi-peon-ping added beyond that is cut: the other eight sound
packs, the pack picker and installer, relay mode for remote sessions,
desktop notifications, the preview sound, and the input.required /
resource.limit categories (pi has no events for those, they were dead
config). Both kept packs play together: every sound pick is random from
both, never repeating the last one per category.

## Architecture

```
pi (coding agent)
  └─ extensions/peon.ts     TS glue: event wiring + /peon settings panel
       └─ src/peon.zig      Zig backend: config, decisions, sound picking
            └─ afplay       spawned per sound with the volume gain
```

- The glue only moves events and settings. The backend owns every decision:
  whether an event plays a sound (paused, category toggles, error gating,
  debounce, silent window), which sound, and the afplay spawn (killing the
  previous sound so lines never overlap).
- The 33 wavs from the peon and peasant packs are embedded in the binary
  (`src/peon/sounds.zig`, generated from the pack manifests) and extracted
  to `~/.pi/agent/peon-sounds/` on startup. Idempotent: existing files are
  skipped.
- Config is `~/.pi/agent/peon.json` (volume percent, paused, silent window,
  spam threshold/window, five category toggles). On first run, values are
  migrated from the old pi-peon-ping config at `~/.config/peon-ping/`
  (volume 0..1 -> percent, carried categories, paused from state.json);
  after that the old paths are never touched again. Unknown old keys
  (default_pack, relay_mode, desktop_notifications, the two dead categories)
  are dropped.
- `afplay` only: the user's platform is macOS, and the wsl/linux player
  matrix of pi-peon-ping was bloat. A failed spawn logs one stderr line and
  plays nothing; audio problems never break the event pipeline.

## Protocol (newline-delimited JSON on stdin/stdout)

```json
{"id":1,"op":"config"}                                       <- {"id":1,"ok":true,"config":{...}}
{"id":2,"op":"set","field":"volume","value":"75%"}           <- {"id":2,"ok":true}
{"id":2,"op":"set","field":"cat:task.error","value":"on"}    <- {"id":2,"ok":true}
{"id":3,"op":"event","event":"session_start","reason":"startup"}
{"id":4,"op":"event","event":"agent_start"}
{"id":5,"op":"event","event":"tool_error"}
{"id":6,"op":"event","event":"agent_end","error":true}
```

Fields: volume (10%..100%), paused (active|paused), silent_window_seconds
(0s..3600s), cat:<category> (on|off). The set op validates and persists.

## Zig behavior

- `session_start` plays session.start for every reason, reload included
  (matches the original).
- `agent_start` plays task.acknowledge, or user.spam when at least
  `annoyed_threshold` prompts arrived within `annoyed_window_seconds`
  (ring buffer of prompt timestamps).
- `tool_error` plays task.error when the category is on.
- `agent_end` plays task.complete only when the run did not end in error
  (this is the fix for the original's bug where an errored run still got
  the cheerful complete sound), at most once per 5s debounce, and only
  when the run took at least `silent_window_seconds` (the original
  compared against session start, which made the setting mean something
  else than its label said).
- One sound at a time: a new play kills and reaps the previous afplay.
  A finished afplay is reaped on the next play, so at most one zombie
  exists.
- State (last played per category, timestamps, debounce clock) is
  in-memory; nothing survives a backend restart except peon.json. The
  original's state.json carried nothing that mattered across sessions.

## Notes

- Sound packs: Orc Peon by tonyyont, Human Peasant by thomasKn
  (OpenPeon CESP, CC-BY-NC-4.0). The generated `src/peon/sounds.zig`
  credits them; regenerating it requires the pack wavs plus a jq pass over
  the manifests, documented in the file header.
- The glue unrefs the backend child and its pipes (shared `createBackend`),
  and the backend self-terminates on stdin EOF like the other backends.
- Sessions with no UI (print mode) never fire the event ops, so no sounds.

# Usage extension (pi-usage)

## Goal

`/usage` is a usage dashboard for the pi agent: per-period usage stats
(graphs, table, insights) plus live provider quota limits (OpenAI Codex
subscription and OpenCode Go). Replaces `@tmustier/pi-usage-extension`
(removed from `~/.pi/agent/settings.json` packages; same command name). The
original extension's UI is ported as-is, its data pipeline is rewritten in
Zig with a binary cache, and the provider-limits view is ported from omp
(can1357/oh-my-pi).

## Architecture

```
pi (coding agent)
  └─ extensions/usage.ts            TS glue: /usage command, TUI rendering
       └─ extensions/lib/usage/     types.ts, graph.ts, export.ts (ported)
            └─ src/usage.zig        Zig backend: scan/parse/cache/aggregate,
                                    insights, provider-limit fetches
```

Why this split:

- pi's inline TUI (`ctx.ui.custom`) is TypeScript-only, so all rendering
  stays in TS. The three original views (graph/table/insights) and their
  keybindings are ported from the tmuster extension nearly verbatim; the
  limits view renders the quota data the backend fetches.
- Everything slow lives in Zig: session-JSONL scanning and parsing, the
  on-disk cache, aggregation into the five periods plus hourly buckets,
  insights, and the HTTPS fetches for provider limits.

## Protocol (newline-delimited JSON on stdin/stdout)

```json
{"id":1,"op":"collect","bounds":{"todayMs":..,"weekStartMs":..,"lastWeekStartMs":..,"last30DaysStartMs":..,"nowMs":..}}
{"id":1,"ok":true,"result":"{\"bounds\":..,\"hourly\":..,\"today\":..,\"thisWeek\":..,\"lastWeek\":..,\"last30Days\":..,\"allTime\":..,\"warnings\":[...]}"}
{"id":2,"op":"limits","codex_access":"...","codex_account_id":"...","codex_email":"..."}
{"id":2,"ok":true,"result":"{\"fetchedAt\":..,\"providers\":[...]}"}
```

- `collect` is local-only. Bounds are computed by the glue (local calendar
  midnights; Zig has no portable local-timezone API). The backend scans
  `~/.pi/agent/sessions` for `.jsonl` files, re-parses only files whose
  (size, mtime) changed since the binary cache (`~/.pi/agent/pi-usage-cache.bin`),
  aggregates, computes insights, and returns one JSON payload. A file that
  fails to stat/read/parse keeps its cached rows and adds a warning to the
  payload, so a partial scan is never persisted as success or reported as
  clean.
- `limits` fetches quota over HTTPS on a worker thread; the main loop polls
  the result pipe with a 20s deadline so a hung network can never block the
  backend. OpenCode Go uses `GET https://opencode.ai/zen/go/v1/usage` with
  `Bearer $OPENCODE_API_KEY` (env). Codex uses
  `GET https://chatgpt.com/backend-api/wham/usage` with the bearer and
  `ChatGPT-Account-Id` from the request: the glue resolves the access token
  (and JWT account id/email) through pi's model registry
  (`getApiKeyAndHeaders` on an openai-codex model), so OAuth refresh and
  `auth.json` rewriting stay in pi and this backend never touches the
  credential file.

## Zig behavior

- The JSONL parser pre-filters lines by byte patterns (assistant/session/
  thinking/compaction/branch_summary/toolResult-with-usage) so
  multi-megabyte tool results are never decoded. Tool-result usage
  (describe_image, web_search) is aggregated as auxiliary provider cost
  under the tool name: those delegated calls report their tokens nowhere
  else, so skipping them understated totals.
- The cache is a binary little-endian format: magic `PIUC`, version 1, an
  interned string table, then per file a fixed-size message record set
  (74 bytes per message). Writes go through a temp file + rename.
- Dedupe of copied branch history uses a hash of (auxiliary, sourceId,
  timestamp, token fingerprint); insights text and thresholds are ported
  verbatim from the original extension (data.ts computeInsights).
- The limits worker's context is heap-owned and the worker frees it on every
  exit path (success, or a write failure after the main loop abandons a
  timed-out request), so it can never read reused stack memory, write into a
  later request's pipe, or leak.

## Notes

- The glue resolves the Codex credentials for the limits op through pi's
  model registry and forwards them per request; the Limits view fetches
  quotas on first view (not at panel open), enforces one in-flight request,
  and drops the result when the panel closes. Scan warnings from the
  collect payload render under the title, so a partial scan is visible.
- The original JSON cache (`usage-extension-cache.json`) is left in place
  but unused; the extension never reads it.
- The cache path differs from the tmuster one, so the two extensions cannot
  corrupt each other's data even if both are installed.
- The worker thread's context and its string fields are gpa-owned and freed
  by the worker itself on every exit path; the main loop's arena is reset on
  the next request. A timed-out request abandons the worker (closes the read
  end, its next write fails, and it cleans itself up) rather than leaking.
- Zig 0.16 API notes: `std.posix` no longer exposes `pipe`/`close`/`write`/
  `getpid`; use `posix.system.pipe(&fds)` / `posix.system.close(fd)` /
  `posix.system.write(fd, ...)` / `posix.system.getpid()` with
  `posix.errno()` for return codes. `std.ArrayList(T)` is the unmanaged
  list; use `std.array_list.AlignedManaged(T, null)` for the managed
  variant. `Io.Dir` replaces `std.fs.cwd()` (`statFile` returns
  `Io.Timestamp` mtime with `.toMilliseconds()`). File stat exposes
  `.permissions` directly (no `.mode`); `File.setPermissions(io, perms)`
  preserves modes. `std.base64.url_safe_no_pad` is a `Codecs` value; the
  decoder is the capitalized `.Decoder` field.

# Btw extension (pi-btw)

## Goal

In-house replacement for the third-party `@narumitw/pi-btw` package
(removed from settings): a `/btw [question]` side chat that stays inside the
session TUI — the transcript remains visible above the window — answers with
the current model at `low` thinking in ELI15 style, and never touches the
main conversation unless the user asks it to. Multiple follow-ups work in
one window (unlike omp's one-message-then-fork), and answers are quick by
design: `low` reasoning plus a `max_tokens` cap.

## Architecture

```
pi (coding agent)
  └─ extensions/btw.ts     TS glue: /btw command, side-chat window, model call
       └─ src/btw.zig      Zig backend: thread state, prompts, format, pbcopy
```

Why this split:

- The window must live inside the pi process: only code loaded into pi can
  call `ctx.ui.custom()`, and only component factories receive the live TUI
  (for `requestRender` and the Input child's focus). The model call must
  also happen in pi: provider credentials are reachable only through
  `ctx.modelRegistry` (`getApiKeyAndHeaders` + `getProvider(...).streamSimple`).
- Everything else is Zig: the ELI15 system prompt (with the main-chat
  excerpt embedded, truncated), the side thread state (turns of
  question/answer), message-list assembly for each ask, the `c` copy / `b`
  branch text formatting, and the pbcopy spawn. The glue never decides
  policy.

The window UX mirrors opencode-go's by-the-way panel (and the copy
affordance PR in oh-my-pi): the composer line is a pi-tui `Input` child, and
bare `c` / `b` act as shortcuts only when the composer is empty and the
thread has content, so draft text is never hijacked.

## Protocol (newline-delimited JSON on stdin/stdout)

```json
{"id":1,"op":"open","context":"<main chat excerpt>","question":"optional first question"}
{"id":1,"ok":true,"system_prompt":"...","messages":[...],"thinking":"low","max_tokens":800}
{"id":2,"op":"ask","question":"follow-up"}        <- {"id":2,"ok":true,"messages":[...]}
{"id":3,"op":"answer","answer":"model text"}      <- {"id":3,"ok":true,"turns":2}
{"id":4,"op":"abort"}                             <- {"id":4,"ok":true,"turns":1}
{"id":5,"op":"format"}                            <- {"id":5,"ok":true,"text":"..."}
{"id":6,"op":"copy"}                              <- {"id":6,"ok":true,"chars":123}
```

## Zig behavior

- `open` resets the thread (one side chat at a time), truncates the context
  to 24KB, and builds the system prompt: ELI15 rules (plain words, short,
  brief, no tool claims) plus the conversation context as background. With a
  first question it records the turn and returns the message list.
- `ask` appends a question (replacing a trailing unanswered turn after an
  error/abort race) and returns the full message list: system prompt plus
  every answered turn as user/assistant pairs plus the new question. Message
  content is always `[{type:"text",text:...}]` blocks: pi's contract
  requires assistant content to be an array of blocks, and its token
  estimator iterates blocks and crashes on a plain string. The glue sends
  exactly this to `streamSimple`.
- `answer` fills the last unanswered turn. `abort` drops it (the glue calls
  abort on Esc and on stream errors, so history only ever builds on answered
  turns).
- `format` renders the answered thread as plain conversation text (question
  and answer without Q/A labels) for copy and bringing into the main chat. `copy` pipes that text into `pbcopy` (macOS);
  a missing pbcopy is reported, never fatal.
- Thread state lives in a dedicated arena reset on `open`; request parsing
  uses a separate per-line arena (reset before each `readLine`).

## Flow

`/btw <question>` -> open (thread + first turn) -> window opens -> stream
the open response messages through `streamSimple` (low thinking, max_tokens
cap, AbortController) -> text deltas render live -> done: `answer` op ->
follow-ups: `ask` op, queue while streaming, one at a time -> `c` copy /
`b` bring to main chat / `esc` dismiss.

## Notes

- `b` brings the Q&A into the main chat as a custom message (`customType
  "btw"`): it renders in the transcript via `registerMessageRenderer` and
  participates in LLM context for later turns, without triggering a turn.
  Forking into a new session file was the alternative; injecting into the
  current session is the simpler match for "bring the by the way session
  back into the main chat".
- `/btw` requires TUI mode: RPC mode hangs on `createBackend` child-pipe
  I/O (an upstream pi quirk), so the guard sits
  at the top of the handler.
- The model call happens through pi's provider registry, so any configured
  provider/model works, with pi's own auth handling. Thinking is fixed at
  `low` and the answer capped at 800 tokens: side questions must be quick.
- Esc always dismisses the window and aborts any in-flight stream; the
  backend thread is dropped on the next `open`.
- The glue unrefs the backend child and its pipes (shared `createBackend`),
  registers `session_shutdown` to tear it down (kill on quit/reload, reset
  on session replacement, shared `handleSessionShutdown`), and the backend
  self-terminates on stdin EOF like the other backends.
# Vision extension (pi-vision)

## Goal

In-house replacement for the third-party @getpipher/vision package: a
`describe_image` tool that works with text-only primaries (deepseek-v4-flash
cannot see images). Multimodal models are left alone entirely: the tool is
hidden from them and pi's native image pass-through does the work, the same
pattern Claude Code / Codex / Amp use. Everything image-related and all HTTP
lives in Zig; the TS glue is ~230 lines of registration, capability sync,
config, and auth resolution.

## Architecture

```
pi (coding agent)
  └─ extensions/vision.ts    TS glue: describe_image tool, capability sync, /vision, paste hint
       └─ src/vision.zig     Zig backend: image detection + sips compression + base64 + HTTP
```

Why this split:

- The glue is the only code inside the pi process, and pi's model registry is
  the only place provider auth lives. The glue resolves the configured vision
  model (`ctx.modelRegistry.find` + `getApiKeyAndHeaders`) and hands the
  base URL, key, and extra headers to Zig per call. Zig stays stateless.
- Zig owns everything else: path resolution, file read, format detection from
  header bytes (PNG/JPEG/GIF/WebP, no decode), dimension check, sips
  compression, base64, the OpenAI-compatible chat/completions request, the
  response parse, the retry, and the deadline.

## Protocol (newline-delimited JSON on stdin/stdout)

```json
{"id":1,"op":"describe","path":"img.png","cwd":"/repo","prompt":"...","base_url":"https://openrouter.ai/api/v1","api_key":"sk-...","model":"xiaomi/mimo-v2.5","headers":"[[\"h\",\"v\"]]","max_dimension":1568,"jpeg_quality":85,"timeout_ms":60000}
{"id":1,"ok":true,"result":"<model text>"}
{"id":1,"ok":false,"error":"..."}
```

`headers` is a JSON string of name/value pairs from pi's provider auth
(serialized by the glue). If it contains no `authorization`, Zig adds
`Authorization: Bearer <api_key>`.

## Zig behavior

- **Compression**: images within `max_dimension` (default 1568) and under
  10MB are sent as-is, byte-for-byte (best quality, zero loss, fastest).
  Bigger images go through `sips -Z <max_dim>` (macOS built-in, same pattern
  as peon's afplay). Opaque images become JPEG at the configured quality
  (default 85); images with alpha keep their transparency — GIF stays GIF,
  PNG and WebP are re-encoded as PNG (sips cannot write WebP). The output
  mime always matches what sips produced. The temp file is unlinked after
  reading.
- **Request**: `POST {base_url}/chat/completions` with the standard
  `image_url` data-URL content block plus the prompt, `max_tokens: 4096`,
  `temperature: 0`. Response text is `choices[0].message.content`, falling
  back to `reasoning_content` for reasoning models that hide the content;
  both fields accept a plain string or a blocks array (`text`/`thinking`/
  `reasoning` blocks, joined with newlines) so block-style responses from
  models like Xiaomi MiMo parse. Parse failures surface the raw body
  (truncated) in the error for diagnosis.
  Non-2xx responses surface the provider's `error.message` with the status.
- **Retry**: one retry after 500ms for 429, 5xx, and network errors. 4xx,
  timeouts, and parse failures fail immediately.
- **Deadline**: the HTTP call runs on a worker thread so a hung provider
  cannot stall the backend. The main thread waits with the deadline (60s
  default, passed per call); on expiry it shuts down the worker's socket
  (unblocking its read), waits up to 1s for it to exit, and joins. If the
  worker is stuck before registering its socket (connect/TLS handshake), it
  is abandoned and frees its own heap structs when it finishes, so repeated
  slow connections cannot accumulate threads or allocations. The glue
  additionally kills the backend on user abort (Esc), so no request can
  outlive its turn.
- **Usage**: the chat/completions `usage` object (prompt/completion tokens)
  is returned on the response line; the glue computes cost from the vision
  model's pricing and reports it as `AgentToolResult.usage`, so delegated
  describe_image tokens and cost appear in pi's footer and /usage totals.
- TLS uses the std lib's system CA bundle, which on macOS reads the system
  keychains directly; no cert file handling.

## Glue behavior

- `describe_image` visibility tracks the active model's capability via
  `pi.getActiveTools()` / `setActiveTools()`: hidden for multimodal models
  (native pass-through, zero delegation), visible for text-only ones.
  Re-synced on `session_start` and `model_select`.
- The `input` hook appends a one-line hint when an image is attached and the
  primary is text-only: pi otherwise replaces pasted images with
  "(image omitted: model does not support images)" and the model never knows
  they existed. Multimodal primaries get the image natively and no hint.
- Config is `~/.pi/agent/vision.json`: `provider`, `model`, `maxDimension`,
  `jpegQuality`. Unknown keys from the old @getpipher/vision config are
  ignored, so the existing file carries over. `/vision show` prints the
  config; `/vision model <provider/model>` validates against the registry
  (must exist and have image input) and saves; bare `/vision model` opens a
  picker over vision-capable models.
- `createBackend` `restart()` (kill now, respawn after the old child exits,
  pending calls reject) is used when an in-flight describe call is aborted;
  other extensions are unaffected.

## Flow

`describe_image(path, prompt)` -> glue resolves the vision model + auth ->
backend reads the image, compresses if needed, base64s, POSTs -> on
retryable failure one retry -> text returned to the model. `Esc` during the
call kills and respawns the backend. `input` with images on a text-only
primary -> hint appended -> model calls describe_image.

## Notes

- The glue unrefs the backend child and its pipes (shared `createBackend`),
  and the backend self-terminates on stdin EOF like the other backends.
- Zig 0.16 API notes: `std.http.Client` is a plain struct
  (`{ .allocator, .io }`), `fetch` discards the body without a
  `response_writer`, `Io.Writer.fixed` buffers capture it (`out.end` is the
  written length), `Io.net.IpAddress.listen`/`connect` take
  `*const IpAddress`, `Io.sleep(io, duration, .awake)` replaces
  nanosleep, `std.Io.net.Stream.Reader.stream` exposes the raw socket for
  deadline shutdowns, and `Connection.stream_reader.stream.socket.handle`
  is the client-side socket. The `Io.Clock` enum has `.real`/`.awake`/
  `.boot` (no `.monotonic`).
- The old `~/.pi/agent/vision-audit.log` from @getpipher/vision is
  orphaned once the package is removed; harmless.

# Search extension (pi-search)

## Goal

In-house replacement for the pi-web-access package (uninstalled) and the
original Codex-backed pi-search: a single `web_search` tool that queries the
Exa API with the user's `EXA_API_KEY` (from the shell environment, e.g.
`~/.zshrc`) and returns a numbered source list with excerpts. Exa has no
built-in answer synthesis, so the model writes the grounded answer and cites
sources as `[n]` markers against the returned list. No config file, no auth
flow: `answer` mode requests longer excerpts (maxCharacters 900) so the
model can synthesize; `results` mode requests short excerpts (250) and
returns just the compact list, faster and cheaper.

## Architecture

```
pi (coding agent)
  └─ extensions/search.ts    TS glue: tool schema, EXA_API_KEY from env
       └─ src/search.zig      Zig backend: Exa request body, response parse,
                              source list formatting, deadline, cost usage
            └─ api.exa.ai/search  (HTTPS, JSON request/response)
```

Why this split:

- The glue's only jobs are the tool schema and the API key: read
  `process.env.EXA_API_KEY` (fails loudly at call time when missing) and
  forward it per call. Esc aborts by SIGTERMing the one-shot binary, so no
  request can outlive its turn.
- Everything else is Zig: the Exa request body (query, numResults capped at
  Exa's standard 10, `type: "auto"` with `useAutoprompt: false` so the query
  is never rewritten, includeDomains/excludeDomains from the domain filters,
  startPublishedDate from the recency filter, contents.text.maxCharacters
  per mode), the JSON response parse (results deduped by url, capped at 30),
  the numbered source list, the single retry, the hard deadline, and the
  cost accounting.

## Protocol (one-shot: one JSON request in argv, one JSON envelope on stdout)

```json
{"op":"search","query":"...","mode":"answer","num_results":8,"recency":"week","domains":["example.com","-bad.com"],"api_key":"...","timeout_ms":30000}
{"ok":true,"result":"Sources:\n1. Title (url)\n   excerpt...","usage":{"input":0,...,"cost":{"total":0.007}}}       <- or {"ok":false,"error":"..."}
```

`domains` entries with a leading `-` are blocked; the rest are allowed.
`recency` is day/week/month/year and maps to `startPublishedDate`, computed
in Zig as an ISO 8601 UTC timestamp via `std.time.epoch`. `num_results`
caps at 10. The tool param names (`mode`, `numResults`, `recencyFilter`,
`domainFilter`) keep the old pi-web-access surface so the model's habits
carry over, and the `[n]` citation habit carries over too: the numbered
source list keeps the same shape, only the answer synthesis moved from the
server to the model.

## Zig behavior

- **Request body**: POST to `https://api.exa.ai/search` with `x-api-key`
  (no other auth) and a JSON body carrying query, numResults, type,
  useAutoprompt, includeDomains, excludeDomains, startPublishedDate, and
  contents.text.maxCharacters. Optional fields are omitted when absent.
  `useAutoprompt: false` matters: Exa rewrites the query by default, and
  the model already planned it.
- **Response parse**: `results[]` objects yield title/url/text, deduped by
  url and capped at 30. A missing `results` array is an error; an empty one
  returns "No results found." as a clean outcome. `costDollars.total` (USD)
  becomes the tool result's usage JSON so /usage aggregates web_search
  under the Tools provider (no tokens to report, cost only).
- **Formatting**: `Sources:` followed by numbered `Title (url)` entries
  with a normalized excerpt (`answer` mode up to 900 chars, `results` mode
  up to 250). Total output capped at 32KB.
- **Failure handling**: non-2xx surfaces Exa's `error`/`message` with the
  status. 429/5xx/network errors retry once after 500ms; 4xx (including
  402 out-of-credits) fail immediately. The HTTP call runs on a worker
  thread with a 30s deadline (the shared `httpWithDeadline` machinery in
  `common.zig`, same as pi-vision), so a hung endpoint cannot stall the
  backend.

## Glue behavior

- The API key comes from `process.env.EXA_API_KEY`; no Codex auth, no pi
  model registry involvement. A missing key yields a clear error telling
  the user to export it before starting pi.
- No config file, no provider selection: the tool is always registered and
  fails loudly at call time without the key.
- The call goes through the shared `callZig` helper (pi.exec + argv JSON),
  so Esc aborts by SIGTERMing the one-shot binary. No backend lifecycle
  exists anymore.

## Flow

`web_search(query, mode, ...)` -> glue reads EXA_API_KEY -> Zig posts the
search and parses the JSON -> numbered source list with excerpts returned
-> the model writes the answer with `[n]` citations resolving to the list.
`results` mode returns just the compact list. Pages that need full content
are fetched with the browser tools.

## Notes

- One-shot: the binary runs once per call and exits. No unref dance, no
  session_shutdown wiring, and in-flight aborts kill only the binary.
- Exa's free tier is 1000 credits per month, one search per credit; the
  per-search cost (currently ~$0.007) rides the tool result's usage so
  /usage reflects it. The old Codex-backed search was replaced because the
  server-side synthesis pipeline (query planning + search + answer
  generation before the first token) regularly blew the 60s deadline;
  Exa returns in milliseconds and the answer synthesis moved to the model,
  which was already writing the final answer anyway.
- `queries` arrays and multi-provider fan-out are deliberately gone: the
  model plans the query, and parallel fan-out to several providers was the
  bloat this extension replaces.
# Footer extension (extensions/footer.ts)

## Goal

Replace pi's built-in status footer with a cleaner, opencode-inspired
footer. Two lines plus optional extension statuses:

```
π  ~/Projects/pi  main *1 ?2 +1                       <- workspace + git status
↑26 ↓44 $0.000 38,234/1.0M 12.4 tok/s   deepseek-v4-flash • max   <- stats, model right
```

Drops the built-in footer's cache segments (R = cache read, W = cache
write, CH = cache hit %) and the `(auto)` auto-compaction marker, and adds
a tok/s readout: live while streaming, frozen at the last value once
idle. All colors come from the active pi theme.

## Architecture

Pure TypeScript glue, no Zig backend: everything is already available to
extensions, so there is no protocol and no backend binary.

- Token/cost totals: summed from `ctx.sessionManager.getEntries()`
  (assistant, toolResult, compaction and branch_summary usage), the same
  data the built-in footer uses.
- Context usage: `ctx.getContextUsage()` absolute tokens over the window
  (`38,234/1.0M`, thousands-separated numerator), colored on the absolute
  token count (warning past 100k, error past 200k, with a fraction-of-
  window fallback of 60%/90% for small windows) instead of the percentage
  of the window that is full, because quality degrades with raw token
  count ("context rot"): NoLiMa (ICML 2025) finds most models at half
  their short-context performance by 32k tokens and Anthropic describes a
  continuous gradient, not a cliff. The source is
  compaction-aware: right after /compact the tokens are unknown until the
  next LLM response, so it shows `?/1.0M`; a `session_compact` listener
  re-renders at that moment (session_info_changed only fires on session
  name changes), and once the next response lands the value anchors on its
  verified usage, which reflects the actual post-compaction context.
- Git branch, extension statuses, provider count: `footerData` passed to
  the `ctx.ui.setFooter()` factory. `onBranchChange` triggers re-renders.
- Git status counters (omp-style): pi only exposes the branch, so the
  extension spawns `git status --porcelain -b` itself on a 5s interval
  while the footer is enabled (plus on branch change) and parses the
  porcelain output into per-file counters appended to the branch:
  `main *1 ?2 +1` = 1 file with unstaged worktree changes, 2 untracked,
  1 staged. A clean tree shows just the branch. The interval is cleared
  on footer dispose and on `/footer` toggle (one `git` spawn every 5s,
  ~10-40ms on a normal repo).
- Model + reasoning level: `ctx.model` and `ctx.thinkingLevel` (live
  getters), right-aligned like the built-in footer, with the `(provider)`
  prefix when more than one provider has models.
- Cost segment: always visible, starting at $0.000 before the first
  billed response.
- tok/s: estimated from streamed characters (`text_delta` +
  `thinking_delta` lengths from `message_update` events, ~4 chars per
  token), smoothed over a sliding 15-second window. It is the last segment
  on the stats line so the rest of the line never shifts when it appears.
  It is always visible: resets to 0.0 at session start, updates live while
  a stream is active and freezes at the last measured value on
  `message_end` (a stream too short to measure live freezes its overall
  average). Providers only report real token usage at stream end, so a
  character-based estimate is the only live option; it is an
  approximation.
- Nerd Font icons: fae-pi U+E22C (the `π` logo), md-folder_open U+F0770
  and fa-code-fork U+F126. Verified present in FiraCode Nerd Font.

## Glue behavior

- Enabled automatically at session start (TUI mode only); the `/footer`
  command toggles between this footer and the built-in one.
- `message_update` / `message_end` / `model_select` /
  `thinking_level_select` / `session_info_changed` / `session_compact`
  handlers call `tui.requestRender()` through a module-level handle that
  `dispose()` clears (identity-checked so a replaced footer cannot null a
  newer one). The `git status` interval is cleared in the same `dispose()`
  and on explicit footer disable.
- Extension statuses set via `ctx.ui.setStatus()` still render on a third
  footer line, same as the built-in footer.
