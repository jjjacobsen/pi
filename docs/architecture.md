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
  run as normal.
- `--self-check` builds a scratch repo under /tmp and exercises analyze,
  validate, and commit end to end. It is the gate for `mise check`.

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

## Self-check

`zig build run -- --self-check` requires lazygit on PATH, builds a scratch
repo under /tmp, verifies prepare succeeds on it and fails on a non-repo
path, and exercises the spawn+wait+report path with a fake `lazygit` script
that exits 42 (no real lazygit is spawned). If the process has no controlling
terminal (CI, detached shells) the spawn portion is skipped with a note,
because /dev/tty is the whole point of the run op.

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
- **Self-check**: `zig build run -- --self-check` exercises parse, start,
  event decisions, complete, blocked, wait, pause, resume, clear, status,
  restore, and the inject action. It is the gate for `mise check`.

## Flow

`/goal <objective> [flags]` -> parse -> start -> inject the goal-mode system
prompt (objective, goal_id, rules) -> the agent works -> `agent_end` ->
backend decides: continue (repeat until the floors are satisfied), stop
(complete / blocked / ceiling / no progress), or send (a follow-up prompt) ->
`agent_settled` dispatches the pending continuation or a due wait deadline ->
`goal_complete` ends the loop -> status line and notification.

## Notes

- The glue unrefs the backend child and its stdin/stdout so pi can exit in
  print mode and on shutdown; the backend self-terminates when stdin closes
  (EOF), so no orphans linger.
- Goal loops need an interactive session: print mode (`pi -p`) runs the
  command handler but never processes the follow-up prompt, so `/goal` in
  print mode is a no-op.
- Pi reloading extensions may leave the old backend process alive if pi keeps
  the pipe fds open. Harmless (idle), cleaned up when pi exits and the pipe
  closes.
