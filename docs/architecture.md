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
  monotonic and realtime clocks (`nowMs` / `nowRealtimeMs`), and the command
  runner (`runCmd`, `gitRoot`, `GitResult`). Since pi-search and pi-vision
  were built, it also holds the HTTP-with-deadline machinery they share
  (`httpWithDeadline`, `WorkerSlot`,
  `workerFinish`, `isRetryableStatus` / `isRetryableErr`, `parseHeaders`):
  each backend keeps its own fetch worker and response parsing, and the
  worker-slot lifecycle (socket shutdown on deadline, abandoned-worker
  self-cleanup when a worker is stuck before registering its socket) lives
  once. Each backend aliases only what it needs and keeps its own request
  parsing, op dispatch, and protocol structs.
- `extensions/lib/zig.ts`: `callZig(pi, binaryName, params, {signal,
  timeout})` runs one backend op. It resolves the binary path (fails with
  a rebuild hint when missing), spawns the binary via `pi.exec` with the
  request as one JSON argv element, parses the stdout envelope, and
  throws on a killed process (abort or timeout), a crash (non-zero exit
  without an envelope), or a protocol error (`ok:false`).

Per-backend protocol details are documented in each extension's section
below; the one-shot wire format is identical everywhere: one JSON request
as a single argv element, one JSON envelope on stdout.

## One-shot design rules

An extension is a one-shot child process: the glue spawns the Zig binary
per call, the binary does its work, prints one envelope, and exits. Never
bring back a persistent backend. The rules below are normative:

- Wire protocol is fixed: one JSON request as a single argv element via
  `pi.exec`, one `{"ok":true,"result":...}` / `{"ok":false,"error":...}`
  envelope on stdout, exit 0/1. No `id` field: one request per process, so
  responses are self-addressing.
- State lives on disk under the agent dir, one file per extension
  (`<name>.json` for config, `<name>-state.json` / `-cache.bin` for
  counters), written atomically (temp file + rename). In-memory backend
  state is gone by design: a new stateful feature must get a state file.
- The glue is the single source of truth for the agent dir path: it
  resolves `getAgentDir()` and passes it as `agent_dir` in the request.
  The backend requires it and fails loudly when missing: no env fallback,
  no hardcoded `~/.pi/agent`. State-free backends never ask for it.
- Session state pi itself needs stays in pi: the glue round-trips session
  entries back in per request instead of the backend reading them.
- Constraints to work around: argv is size-limited (keep payloads under
  ~100 KiB); secrets in argv are visible to same-user processes, prefer
  env-derived keys; `pi.exec` has no stdin and no env override; the exit
  code is a fallback channel, the envelope is authoritative; custom tool
  results are not auto-truncated, so keep Zig-side output caps.

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
  and the commit itself. The model writes, the backend judges. The glue
  spawns the backend fresh per op via `pi.exec` (shared `callZig` helper);
  each op is one JSON argv element in, one envelope on stdout, exit 0/1.
  No persistent bridge exists anymore.

## Protocol (one-shot: one JSON request in argv, one JSON envelope on stdout)

```json
{"op":"analyze","cwd":"/path"}          -> {"ok":true,"result":"<markdown context>"}
{"op":"analyze","cwd":"/path"}          -> {"ok":true,"result":""}        nothing staged
{"op":"validate","message":"feat(x): ...\n\n..."} -> {"ok":true,"result":"ok"} | {"ok":false,"error":"- problem\n- problem"}
{"op":"commit","message":"..."}         -> {"ok":true,"result":"<short-hash> <header>"}
```

The backend is stateless, so the request carries no `agent_dir` (no config,
no state file). The clean-repo analyze result is an empty result string,
which the glue turns into an info notify ("nothing to commit") rather than
an error; the context block is never empty when files are staged, so the
marker is unambiguous. Each op runs under a 60s cap in the glue; Esc aborts
by SIGTERMing the one-shot binary regardless of the cap.

## Zig behavior

- `analyze` first blocks if `goal.md` or `handoff.md` exists in the repository
  root. Otherwise it runs `git add -A`: the working tree is snapshotted when
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
- pi is not paused while lazygit runs: `tui.stop()` only hides the TUI frame,
  the agent loop keeps running behind lazygit (same exposure as Ctrl+G).

## Protocol (one-shot, one JSON argv element in, envelope on stdout)

```json
pi.exec("pi-lg", [`{"op":"prepare","cwd":"/path"}`]) -> {"ok":true,"result":"/path/to/repo-root"}
pi.exec("pi-lg", [`{"op":"run","cwd":"/path"}`])     -> {"ok":true,"result":"exited 0"}   (exited N / signal N / stopped / unknown)
                                                           -> {"ok":false,"error":"..."}        failures
```

The glue spawns the binary fresh per op via pi.exec (shared callZig helper);
the backend prints one envelope and exits. There is no id: one request per
process. pi-lg is stateless, so no state file and no agent_dir field.

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
- While lazygit runs it owns the terminal in raw mode, so Ctrl+C / Ctrl+Z are
  lazygit key events, not signals to pi. But pi-lg itself installs a
  SIGTERM/SIGINT handler that forwards to the running lazygit child: when pi
  aborts or tears down the session mid-lazygit, killing the child returns the
  terminal to a sane state instead of leaving lazygit orphaned on the tty.
  (The child pid is published in a global read by the async-signal-safe
  handler; lazygit is reaped on the main thread's `child.wait`.)

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

# Neovim extension (pi-nvim)

## Goal

Open neovim full-screen over the pi TUI with `/nvim`, the direct mirror of
`/lg`: nvim takes the whole terminal, `:q` returns to pi. Same one-shot
shape as lazygit, so all process logic lives in Zig and the TS glue only
owns the pi TUI lifecycle.

## Architecture

```
pi (coding agent)
  └─ extensions/nvim.ts     TS glue: /nvim command, TUI stop/start around run
       └─ src/nvim.zig      Zig backend: validation, /dev/tty handoff, spawn+wait
            └─ nvim         spawned with stdin/stdout/stderr = /dev/tty
```

The design and rationale are identical to the lazygit extension: the TUI
suspend/resume (tui.stop()/tui.start()) must run inside the pi process,
so the glue uses ctx.ui.custom() to grab the live TUI reference (the same
mechanism as Ctrl+G / app.editor.external). Everything process-related is
Zig.

## Protocol (one-shot)

```json
pi.exec("pi-nvim", [`{"op":"prepare","cwd":"/path"}`]) -> {"ok":true,"result":"/path"}
pi.exec("pi-nvim", [`{"op":"run","cwd":"/path"}`])     -> {"ok":true,"result":"exited 0"}   (exited N / signal N / stopped / unknown)
                                                                -> {"ok":false,"error":"..."}        failures
```

## Zig behavior

- prepare runs before the TUI stops so a common failure surfaces as a
  notification with no screen flicker: nvim --version (PATH check). Unlike
  lazygit there is no git-repo validation, because nvim opens any directory;
  it returns the resolved target path.
- run opens /dev/tty and spawns nvim with stdin/stdout/stderr pointing at
  it, cwd = the target. nvim owns the terminal in raw mode; the backend
  blocks in child.wait and reports the term.
- The same SIGTERM/SIGINT background handler as lazygit forwards an abort to
  the running nvim child so a teardown mid-nvim returns the terminal to a
  sane state instead of orphaning nvim (lazygit applies it too).

## Flow

/nvim -> resolve target (ctx.cwd, or /nvim <path>) -> prepare (error =>
notify, no screen change) -> tui.stop() -> run (Zig spawns nvim)
-> tui.start() + full redraw + close component -> notify nvim exited N.

## Known limitations

- Same as lazygit: Unix-only by design (/dev/tty), a brief TUI blink on a
  late spawn failure, and an orphaned nvim if pi itself dies while nvim
  runs. All acceptable for the same reasons.

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
       └─ src/peon.zig      one-shot backend: config, decisions, sound picking
            └─ afplay       spawned per sound with the volume gain
```

- The glue only moves events and settings. The backend owns every decision:
  whether an event plays a sound (paused, category toggles, error gating,
  debounce, silent window), which sound, and the afplay spawn (cutting off
  the previous sound so lines never overlap).
- The 33 wavs from the peon and peasant packs are embedded in the binary
  (`src/peon/sounds.zig`, generated from the pack manifests) and extracted
  to `<agent_dir>/peon-sounds/` on every call. Idempotent: existing files
  are skipped. `agent_dir` is resolved by the glue via `getAgentDir()` and
  sent in the request; the backend fails loudly when it is missing (no
  `~/.pi/agent` fallback).
- Config is `<agent_dir>/peon.json` (volume percent, paused, silent window,
  spam threshold/window, five category toggles). It is read on every call
  and rewritten by the set op.
- `afplay` only: the user's platform is macOS, and the wsl/linux player
  matrix of pi-peon-ping was bloat. A failed spawn logs one stderr line and
  plays nothing; audio problems never break the event pipeline.

## Protocol (one-shot, request as one JSON argv element)

```json
{"op":"config","agent_dir":"..."}                                       -> {"ok":true,"result":"<config json>"}
{"op":"set","field":"volume","value":"75%","agent_dir":"..."}         -> {"ok":true}
{"op":"set","field":"cat:task.error","value":"on","agent_dir":"..."}  -> {"ok":true}
{"op":"event","event":"session_start","reason":"startup","agent_dir":"..."}
{"op":"event","event":"agent_start","agent_dir":"..."}
{"op":"event","event":"tool_error","agent_dir":"..."}
{"op":"event","event":"agent_end","error":true,"agent_dir":"..."}
```

Fields: volume (10%..100%), paused (active|paused), silent_window_seconds
(0s..3600s), cat:<category> (on|off). The set op validates and persists.
Errors leave the result out: `{"ok":false,"error":"..."}`, exit 1. The
config op carries the config serialized in its result text (the glue
re-parses it for the settings panel). No argv prints a usage line, exit 2.

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
- One sound at a time: a new play terminates the afplay whose pid is in
  state, then spawns its own. The previous afplay is orphaned when the
  process exits (reparented to launchd), so no zombies ever exist.

## Cross-call state (<agent_dir>/peon-state.json)

Every event is its own process, so the counters that used to live in the
backend's memory round-trip through `peon-state.json`, loaded before an
event op and written atomically (temp + rename) after it: the 5s debounce
clock (`last_stop_time`), the silent-window baseline (`last_agent_start`),
the spam timestamp ring, the last played index per category, and the pid of
the still-running afplay. The glue serializes event calls through a promise
chain so two back-to-back events cannot interleave their state read/write
(the old persistent backend serialized them on its pipe for free). A state
file problem never breaks a notification: it logs to stderr and that
counter resets to its default for the event.

## Notes

- Sound packs: Orc Peon by tonyyont, Human Peasant by thomasKn
  (OpenPeon CESP, CC-BY-NC-4.0). The generated `src/peon/sounds.zig`
  credits them; regenerating it requires the pack wavs plus a jq pass over
  the manifests, documented in the file header.
- Sessions with no UI (print mode) never fire the event ops, so no sounds.

# Usage extension (pi-usage)

## Goal

`/usage` is a usage dashboard for the pi agent: per-period usage stats
(graphs, table) plus live provider quota limits (OpenAI Codex
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
                                    provider-limit fetches
```

Why this split:

- pi's inline TUI (`ctx.ui.custom`) is TypeScript-only, so all rendering
  stays in TS. The two original views (graph/table) and their
  keybindings are ported from the tmuster extension nearly verbatim; the
  limits view renders the quota data the backend fetches.
- Everything slow lives in Zig: session-JSONL scanning and parsing, the
  on-disk cache, aggregation into the five periods plus hourly buckets,
  and the HTTPS fetches for provider limits.

## Protocol (one JSON request as a single argv element, one JSON envelope on stdout)

```json
{"op":"collect","bounds":{"todayMs":..,"weekStartMs":..,"lastWeekStartMs":..,"last30DaysStartMs":..,"nowMs":..},"agent_dir":"..."}
{"ok":true,"result":"{\"bounds\":..,\"hourly\":..,\"today\":..,\"thisWeek\":..,\"lastWeek\":..,\"last30Days\":..,\"allTime\":..,\"warnings\":[...]}"}
{"op":"limits","codex_access":"...","codex_account_id":"...","codex_email":"..."}
{"ok":true,"result":"{\"fetchedAt\":..,\"providers\":[...]}"}
```

- `collect` is local-only. Bounds are computed by the glue (local calendar
  midnights; Zig has no portable local-timezone API), and the agent dir
  rides the request (the glue's `getAgentDir`, pi's own resolution, never
  an env fallback). The backend scans `<agent_dir>/sessions` for `.jsonl`
  files, re-parses only files whose (size, mtime) changed since the binary
  cache (`<agent_dir>/pi-usage-cache.bin`), aggregates, and returns one JSON
  payload. A file that fails to stat/read/parse keeps
  its cached rows and adds a warning to the payload, so a partial scan is
  never persisted as success or reported as clean.
- `limits` fetches quota over HTTPS on the main thread; a hung network is
  bounded by the glue's `pi.exec` timeout (30s). OpenCode Go uses
  `GET https://opencode.ai/zen/go/v1/usage` with `Bearer $OPENCODE_API_KEY`
  (env). Codex uses `GET https://chatgpt.com/backend-api/wham/usage` with
  the bearer and `ChatGPT-Account-Id` from the request: the glue resolves
  the access token (and JWT account id/email) through pi's model registry
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
  timestamp, token fingerprint).

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

## Protocol (one-shot: one JSON request in argv, one JSON envelope on stdout)

```json
{"op":"describe","path":"img.png","cwd":"/repo","prompt":"...","base_url":"https://openrouter.ai/api/v1","api_key":"sk-...","model":"xiaomi/mimo-v2.5","headers":"[[\"h\",\"v\"]]","max_dimension":1568,"jpeg_quality":85,"timeout_ms":60000}
{"ok":true,"result":"<model text>","usage":{"input":...,"output":...}}       <- or {"ok":false,"error":"..."}
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
  slow connections cannot accumulate threads or allocations. Esc aborts the
  call: pi.exec SIGTERMs the one-shot binary, so no request can outlive its
  turn.
- **Usage**: the chat/completions `usage` object (prompt/completion tokens)
  is returned on the response envelope; the glue computes cost from the
  vision model's pricing and reports it as `AgentToolResult.usage`, so
  delegated describe_image tokens and cost appear in pi's footer and /usage
  totals.
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
- The call goes through the shared `callZig` helper (pi.exec + argv JSON),
  so Esc aborts by SIGTERMing the one-shot binary. No backend lifecycle
  exists anymore.

## Flow

`describe_image(path, prompt)` -> glue resolves the vision model + auth ->
Zig reads the image, compresses if needed, base64s, POSTs -> on retryable
failure one retry -> text returned to the model. `Esc` during the call
SIGTERMs the one-shot binary. `input` with images on a text-only primary ->
hint appended -> model calls describe_image.

## Notes

- The delegated token usage rides the response envelope; the glue's
  `toToolUsage` converts it into pi's Usage shape (with cost computed from
  the model's pricing) so /usage counts it.
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
`results` mode returns just the compact list.

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

# Subagent extension (extensions/subagent.ts)

## Goal

Hand off meaty, self-contained tasks to an isolated sub-session so the
caller's context window stays low. The main session only ever contains
the task string and the returned summary; the subagent's full transcript
lives in its own session. The tool is `subagent` with a required task and
optional per-call model and reasoning overrides. This is a structural
exception to the one-shot backend model because it runs *another pi agent
loop* inside the main process

## Architecture

Pure TypeScript, no Zig backend. The "backend" is pi's own agent loop:
every `subagent` call runs a second, fully isolated `AgentSession` via
the SDK (`createAgentSession`) in the same process, prompts it with the
task, waits for it to finish, and returns only its final message as the
tool result.

- One `AgentSession` per tool call, fully independent. Pi executes
  sibling tool calls from one assistant turn concurrently, so several
  `subagent` calls in one turn run several subagents in parallel. No
  shared mutable state between sub-sessions.
- Sub-session tools: the built-ins (`read`, `bash`, `edit`, `write`)
  plus the allowlisted extensions `search.ts` (`web_search`) and
  `vision.ts` (`describe_image`). A `DefaultResourceLoader` with an
  `extensionsOverride` filters every other extension out by source file
  name, so `subagent` cannot recurse into itself and the sub-session's
  system prompt stays small. The explicit `tools` allowlist is the second
  guard: only the six names are ever callable. Skills and
  AGENTS.md context files load normally, so the subagent follows the
  same project conventions.
- Model and thinking level inherit independently from the caller
  (`ctx.model` / `ctx.thinkingLevel`) when their optional tool parameters
  are omitted. A model override is an exact `provider/model` reference or
  an unambiguous bare model ID. An explicit reasoning override must be one
  of pi's supported levels and must be supported by the selected model or
  the call fails. When only the model is overridden, pi clamps the inherited
  parent level to that model's supported levels.
- Transcripts persist under `<agent_dir>/subagents/<ts>_<id>.jsonl`
  (a `SessionManager.create` with a custom session dir), link the main
  session via `parentSession`, and can be resumed with
  `SessionManager.open`. `/usage` never sees them: the usage collect
  scan only reads `<agent_dir>/sessions`.
- Cost accounting: the combined usage of the sub-session's assistant
  messages is summed and returned on the tool result's `usage` field,
  which pi persists, so `/usage` aggregates the subagent spend under the
  caller's session exactly like `web_search` costs.
- The model catalog + auth runtime (`ModelRuntime.create`) and the
  filtered loader are created once per process (lazy) and shared across
  calls. `pi`'s cwd is fixed per process, so the loader's cwd cannot
  drift.

## Glue behavior

- One tool `subagent` with required `task` plus optional `model` and
  `reasoning` parameters. Omitting both preserves the original behavior.
  The description tells the main agent when to delegate, when to inherit,
  and to fire independent tasks as parallel calls.
- Live progress: `text_delta` events stream into `onUpdate` (rolling
  tail, capped for display) so the TUI shows the subagent working.
- Cancellation: the tool's abort signal calls `session.abort()`, the
  model call stops, and the partial transcript stays on disk.
- The final assistant message is the report: extracted, truncated with
  `truncateHead` to the tool result limit, and returned with the
  transcript path so the caller can point follow-up work at it. Tool-result
  details also record the effective `provider/model` and reasoning level.

## Notes

- Startup per call is heavier than a Zig one-shot (loader reload +
  two extension factories + agent loop), around a second, which is
  irrelevant next to the LLM run it gates.
- Concurrency is unbounded for now: N parallel subagents is N streams
  on the caller's API key. Rate limits are the practical ceiling.
