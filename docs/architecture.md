# Shared code (pi-common / pi-backends)

All four extension pairs share the same shape: a thin TS entry point that
spawns a Zig backend and speaks newline-delimited JSON over stdio. The
shared parts live in two files:

- `src/common.zig`: IO, JSON, and process helpers used by every backend —
  the line reader with deadline (`readLine`), buffered writer
  (`writeAllIo`), JSON-escaped responder (`respond`), monotonic and
  realtime clocks (`nowMs` / `nowRealtimeMs`), and the command runner
  (`runCmd`, `gitRoot`, `GitResult`). Each backend aliases only what it
  needs and keeps its own request parsing, op dispatch, protocol structs,
  and self-check. `goal.zig` aliases `nowRealtimeMs` because its deadlines
  must be comparable to the glue's wall time; the others use the monotonic
  clock.
- `extensions/lib/backend.ts`: `createBackend(binaryName, hooks)` owns spawning
  the binary, the pending-call map, line dispatch, and the unref dance that
  lets pi exit in print mode while the backend self-terminates on stdin EOF.
  It is also what makes `/reload` trustworthy: before spawning it rebuilds
  with `zig build` whenever any source (build.zig, build.zig.zon,
  src/**/*.zig) is newer than the binary, and a failed build throws instead
  of running a stale binary. `createBackend` returns `{call, kill}`; every
  extension registers `pi.on("session_shutdown", () => backend.kill())`, so
  reloads, session switches, forks, and quits tear the old backend down
  (stdin EOF, SIGTERM insurance) instead of orphaning it until pi exits.
  `hooks.onOk` picks the resolved value (browser resolves the raw result
  string); `hooks.onError` returns the error message (goal adds a fallback).

Per-backend protocol details are documented in each extension's section
below; the wire format is identical everywhere: one JSON request line on
stdin, one JSON response line on stdout.

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
- **/reload**: the glue rebuilds stale binaries and every extension kills
  its backend on `session_shutdown`, so a reload after editing Zig or TS
  code runs the new build with no orphaned processes. In-flight backend
  calls during a reload fail fast ("backend killed"), which is intended:
  reload is terminal for the old instance.
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
- Pi reloading extensions kills the old backend via `session_shutdown`
  (shared `createBackend` kill), and the glue rebuilds stale binaries, so
  `/reload` runs current code with no orphaned processes.

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
- **Self-check**: `zig build run -- --self-check` exercises defaults,
  migration (with a fake old install in a temp home), extraction, all
  event decisions with synthetic clocks, set validation, and persistence.
  It is the gate for `mise check`.

## Notes

- Sound packs: Orc Peon by tonyyont, Human Peasant by thomasKn
  (OpenPeon CESP, CC-BY-NC-4.0). The generated `src/peon/sounds.zig`
  credits them; regenerating it requires the pack wavs plus a jq pass over
  the manifests, documented in the file header.
- The glue unrefs the backend child and its pipes (shared `createBackend`),
  and the backend self-terminates on stdin EOF like the other backends.
- Sessions with no UI (print mode) never fire the event ops, so no sounds.

# Worktree extension (pi-wt)

## Goal

Run multiple pi agents in parallel on one repo, each isolated in its own git
worktree. `/wt` creates a worktree from the current branch head (never
carrying uncommitted changes), then replaces the current pi session with a
fresh session rooted at the worktree. Merging the worktree back and cleaning
up is part of the same command.

## Architecture

```
pi (coding agent)
  └─ extensions/wt.ts     TS glue: /wt command, session replacement, auto-prune
       └─ src/wt.zig      Zig backend: all git logic (create/list/merge/prune)
```

Why this split:

- Session replacement must run inside the pi process: only code loaded into
  pi can call `ctx.switchSession`. The glue writes the new session file's
  header itself (via `SessionManager.create(path)` for the path and session
  dir, then a direct header write): interactive mode drops `cwdOverride`
  from `ctx.switchSession` (pi's `handleResumeSession` only forwards
  `withSession`), so the file must carry the worktree path in its header
  before the switch, or the new session falls back to the process cwd and
  keeps operating on the main checkout.
- Everything git-related lives in Zig: worktree creation and discovery,
  name generation, the `.git/info/exclude` write, merge execution with
  conflict detection, and safe pruning. The glue never runs git.

## Protocol (newline-delimited JSON on stdin/stdout)

```json
{"id":1,"op":"create","cwd":"/path","topic":"optional"}        -> Zig
{"id":1,"ok":true,"result":"{\"path\":...,\"branch\":...,\"topic\":...,\"base\":...}"}
{"id":2,"op":"list","cwd":"/path"}                             ->
{"id":2,"ok":true,"result":"* main   .  clean\n  wt/x   .wt/x  clean"} <-
{"id":3,"op":"merge","cwd":"/path","topic":"x"}                ->
{"id":3,"ok":true,"result":"{\"merged\":true,\"up_to_date\":false,\"branch\":...,\"text\":...}"}
{"id":4,"op":"prune","cwd":"/path","topic":"x"}                ->
{"id":4,"ok":true,"result":"removed ... , deleted branch ..."} <-
```

create and merge return a JSON object string in `result` that the glue
parses. All other ops return plain text.

## Zig behavior

- `create` validates the repo (must be a git repo with at least one commit),
  computes the topic (user word sanitized to `[a-z0-9-]`, or a generated
  adjective-noun name like `angry-aardvark`), and checks collisions. Explicit
  topics error on collision; generated names re-roll up to 25 times. It then
  writes `.wt/` into `.git/info/exclude` (a local, never-committed file, so
  worktrees never show as untracked noise) and runs
  `git worktree add -b wt/<topic> <root>/.wt/<topic> HEAD`. The response
  carries the absolute worktree path, branch, topic, and the base branch
  label. The name generator is seeded from the monotonic clock mixed with a
  stack address; collision re-rolls guard against repeats.
- `list` parses `git worktree list --porcelain` and reports branch (or
  `(detached)`), path relative to the repo root, and clean/dirty via a
  `status --porcelain` probe per worktree. The worktree containing the
  caller's cwd gets a `*` marker.
- `merge` finds the worktree for a topic (branch `wt/<topic>`, branch
  `<topic>`, or path ending in `/.<topic>`), refuses to merge a worktree into
  itself, and runs `git merge --no-edit` in the caller's checkout. One rule:
  bring `wt/<topic>` into whatever branch the caller is on. Fast-forward
  when possible, merge commit otherwise, `--no-edit` so no editor can hang
  the backend. A failed merge with unmerged paths is reported as
  `merge conflicts in <files>; resolve and commit`; any other failure
  surfaces git's own stderr (e.g. local changes would be overwritten). An
  up-to-date merge whose worktree holds uncommitted changes reports those
  files and tells the user to commit or stash first, instead of a
  misleading "already up to date".
- `prune` runs `git worktree remove` (refuses on a dirty worktree, no
  `--force`) then `git branch -d` (refuses on an unmerged branch, no `-D`).
  A dirty worktree is reported with the offending files (git's own error
  suggests `--force`, which would delete the user's work); a leftover
  branch is reported, never force-deleted.
- **Self-check**: `zig build run -- --self-check` builds a scratch repo and
  exercises create (explicit and auto-named), the exclude write, listing,
  a fast-forward merge, prune, duplicate-topic rejection, self-merge
  rejection, a real conflict, pruning an unmerged branch, an up-to-date
  merge with a dirty worktree (merge and prune both report the uncommitted
  files), and the non-repo error. It is the gate for `mise check`.

## Flow

`/wt` -> create worktree (Zig) -> write the fresh session file's header with
cwd = worktree directory (`SessionManager.create` + explicit header write) ->
`ctx.switchSession` (cwdOverride also passed, harmless) -> notify on the new
session. `/wt merge <topic>` -> merge (Zig) -> on success auto-prune (Zig)
unless `--keep` -> notify. `/wt list` and `/wt prune` are one-shot ops.

## Notes

- Sessions are stored per-directory, so the main checkout session and the
  worktree session are fully isolated files. The worktree session starts
  fresh with no carried-over context, matching the command's purpose.
- Opening a second pi in the main repo while another pi is active there
  continues the same session file; `/wt` switches away immediately, which
  self-corrects. Type it before doing anything else in that terminal.
- The worktree directory is a new path for pi's project trust store, so the
  first switch prompts once to trust it, like any new directory.
- The glue unrefs the backend child and its pipes (shared `createBackend`),
  and the backend self-terminates on stdin EOF like the other backends.
- Zig 0.16 API notes for future backends: `std.ArrayList(T)` is now the
  unmanaged list (`append(self, gpa, item)`, init with `.empty`),
  `std.crypto.random` was removed (seed name generators from the clock
  instead), and `std.fmt.allocPrint` used inside a struct-literal return
  needs `try` before `allocPrint`.
- **RPC mode hangs on backend I/O (upstream pi quirk)**: any extension await
  on a `createBackend` child pipe stalls in rpc mode, so `/wt` guards
  `ctx.mode !== "tui"` and refuses there. The worktree would still be
  created (the backend runs) before the hang, which is why the guard sits at
  the top of the handler.

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
{"id":1,"ok":true,"result":"{\"bounds\":..,\"hourly\":..,\"today\":..,\"thisWeek\":..,\"lastWeek\":..,\"last30Days\":..,\"allTime\":..}"}
{"id":2,"op":"limits"}
{"id":2,"ok":true,"result":"{\"fetchedAt\":..,\"providers\":[...]}"}
```

- `collect` is local-only. Bounds are computed by the glue (local calendar
  midnights; Zig has no portable local-timezone API). The backend scans
  `~/.pi/agent/sessions` for `.jsonl` files, re-parses only files whose
  (size, mtime) changed since the binary cache (`~/.pi/agent/pi-usage-cache.bin`),
  aggregates, computes insights, and returns one JSON payload.
- `limits` fetches quota over HTTPS on a worker thread; the main loop polls
  the result pipe with a 20s deadline so a hung network can never block the
  backend. OpenCode Go uses `GET https://opencode.ai/zen/go/v1/usage` with
  `Bearer $OPENCODE_API_KEY` (env). Codex uses
  `GET https://chatgpt.com/backend-api/wham/usage` with the OAuth bearer and
  `ChatGPT-Account-Id` from `~/.pi/agent/auth.json`; when the access token
  is expired it refreshes via `https://auth.openai.com/oauth/token`
  (`grant_type=refresh_token`, `client_id=app_EMoamEEZ73f0CkXaXp7hrann`) and
  rewrites auth.json atomically, preserving other provider entries and the
  original file mode. Account id/email come from JWT claims.

## Zig behavior

- The JSONL parser pre-filters lines by byte patterns (assistant/session/
  thinking/compaction/branch_summary) so multi-megabyte tool results are
  never decoded. Tool-result usage is deliberately ignored: the original
  extension only used it for nested-agent reconciliation, and there are no
  subagent records in practice.
- The cache is a binary little-endian format: magic `PIUC`, version 1, an
  interned string table, then per file a fixed-size message record set
  (74 bytes per message). Writes go through a temp file + rename.
- Dedupe of copied branch history uses a hash of (auxiliary, sourceId,
  timestamp, token fingerprint); insights text and thresholds are ported
  verbatim from the original extension (data.ts computeInsights).
- **Self-check**: `zig build run -- --self-check` builds a scratch session
  tree, runs the real parse/aggregate/cache pipeline with
  `PI_CODING_AGENT_DIR` pointed at it, verifies the payload and cache round
  trip, and checks that the limits op fails gracefully without credentials
  (no network in the self-check).

## Notes

- The original JSON cache (`usage-extension-cache.json`) is left in place
  but unused; the extension never reads it.
- The cache path differs from the tmuster one, so the two extensions cannot
  corrupt each other's data even if both are installed.
- The worker thread's `agent_dir` string is copied to the gpa before
  spawning; the main loop's arena is reset on the next request. On timeout
  the copy leaks (~50 bytes, rare) rather than risking a use-after-free.
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
{"id":5,"op":"format"}                            <- {"id":5,"ok":true,"text":"Q: ...\nA: ..."}
{"id":6,"op":"copy"}                              <- {"id":6,"ok":true,"chars":123}
```

## Zig behavior

- `open` resets the thread (one side chat at a time), truncates the context
  to 24KB, and builds the system prompt: ELI15 rules (plain words, short,
  brief, no tool claims) plus the conversation context as background. With a
  first question it records the turn and returns the message list.
- `ask` appends a question (replacing a trailing unanswered turn after an
  error/abort race) and returns the full message list: system prompt plus
  every answered turn as user/assistant pairs plus the new question. The
  glue sends exactly this to `streamSimple`.
- `answer` fills the last unanswered turn. `abort` drops it (the glue calls
  abort on Esc and on stream errors, so history only ever builds on answered
  turns).
- `format` renders the answered thread as plain `Q: ... / A: ...` blocks for
  copy and branch-to-chat. `copy` pipes that text into `pbcopy` (macOS);
  a missing pbcopy is reported, never fatal. The `bin` request field
  overrides the binary for the self-check's fake pbcopy.
- Thread state lives in a dedicated arena reset on `open`; request parsing
  uses a separate per-line arena (reset before each `readLine`).
- **Self-check**: `zig build run -- --self-check` exercises open (with and
  without a first question), answer, ask history, abort, format, and copy
  through a fake pbcopy script that saves stdin to a file. It is the gate
  for `mise check`.

## Flow

`/btw <question>` -> open (thread + first turn) -> window opens -> stream
the open response messages through `streamSimple` (low thinking, max_tokens
cap, AbortController) -> text deltas render live -> done: `answer` op ->
follow-ups: `ask` op, queue while streaming, one at a time -> `c` copy /
`b` branch / `esc` dismiss.

## Notes

- `b` brings the Q&A into the main chat as a custom message (`customType
  "btw"`): it renders in the transcript via `registerMessageRenderer` and
  participates in LLM context for later turns, without triggering a turn.
  Forking into a new session file was the alternative; injecting into the
  current session is the simpler match for "bring the by the way session
  back into the main chat".
- `/btw` requires TUI mode: RPC mode hangs on `createBackend` child-pipe
  I/O (the same upstream pi quirk documented for `/wt`), so the guard sits
  at the top of the handler.
- The model call happens through pi's provider registry, so any configured
  provider/model works, with pi's own auth handling. Thinking is fixed at
  `low` and the answer capped at 800 tokens: side questions must be quick.
- Esc always dismisses the window and aborts any in-flight stream; the
  backend thread is dropped on the next `open`.
- The glue unrefs the backend child and its pipes (shared `createBackend`),
  and the backend self-terminates on stdin EOF like the other backends.
