# Papercuts

## 2026-08-13

- A `b.addRunArtifact` run does not update `zig-out/bin/pi-browser`: it
  runs from the build cache, only `installArtifact` writes zig-out. After
  editing `src/`, run plain `zig build` before driving the binary directly,
  or you test a stale build (cost a full repro cycle while debugging the
  browser log spam).
- Zig 0.16 removed `std.time.milliTimestamp()`. The supported way to read a
  clock is `std.c.clock_gettime(std.c.CLOCK.MONOTONIC, &ts)` with a
  `std.posix.timespec`; note the field names are `sec`/`nsec` on macOS and
  `tv_sec`/`tv_nsec` on Linux. Also, `std.posix.poll`'s error set in 0.16
  does not include `error.Interrupted`, so a `switch` on it fails to compile.
- `lightpanda mcp --help` claims `--http-timeout` defaults to 10000, but
  `src/Config.zig` (`httpTimeout orelse 5000`) is the actual default. Trust
  the source, not the help text.
- The pi vision tool (describe_image) returned "Vision model returned no
  content" for a Ghostty TUI screenshot; OCR'd it with a one-off Swift
  script using the Vision framework (`VNRecognizeTextRequest`, accurate
  level) instead. Useful technique for TUI/terminal screenshots.

## 2026-08-15

- Zig 0.16 generic thread helpers: when a shared helper takes a worker as a
  `comptime worker: fn (*@TypeOf(ctx), ...) void` parameter, the `*` must be
  spelled out. Writing `fn (@TypeOf(ctx), ...)` compiles the signature as a
  by-value ctx and the caller's `*WorkerCtx` worker fails with "cannot cast
  into" — cost one compile cycle while consolidating the vision/search HTTP
  machinery into common.zig.

## 2026-08-15

- Zig 0.16 removed several `std.mem` helpers: `trimRight`, `trimLeft`,
  `asciiLowerString`. Use `mem.trim` and `std.ascii.lowerString(dst, src)`.
  `std.posix.mkdir` and `std.posix.getpid` are also gone; dir creation is
  `std.Io.Dir.createDirPath`, and there is no portable `getpid` (the
  `std.os.linux.getpid()` trap SIGSYS on macOS, cost one crash).
- `std.process.run` in 0.16 has no stdin pipe (always `.ignore`); for
  `git commit -F -` you must `spawn` manually, write stdin, close it, drain
  stdout/stderr with raw `posix.read`, then `child.wait`. Close the pipe
  files yourself and null the child fields, like pi-browser does.
- `Io.Dir.readFileAlloc(dir, io, path, allocator, limit)` takes an
  `Io.Limit` (`.limited(n)`), not a byte count; wrong arg order silently
  means `error.StreamTooLong` for big files.
- `std.process.run` failure (including `error.StreamTooLong`) must be
  caught: it returns an error union, and on error the stdout/stderr buffers
  are freed. Treat it as a `GitResult.ok == false` with the error name as
  the message.

## 2026-08-15 (goal extension)

- pi's `getArgumentCompletions` must return `AutocompleteItem[]`
  (`{value, label, description?}`), not plain strings. Strings crash the
  TUI with an uncaught `TypeError: Cannot read properties of undefined
  (reading 'length')` in pi-tui's select-list `visibleWidth`. The docs
  example shows the shape but the crash message gives no hint.
- GNU `timeout` is not on macOS. Shell tests that rely on it fail with
  `command not found`; use a background process + `sleep` + `ps` + `kill`
  instead.
- Extensions that spawn a backend child with piped stdio keep pi's event
  loop alive: `pi -p` never exits after print mode (browser.ts, commit.ts,
  lazygit.ts, goal.ts all had this). Unref the child and its stdin/stdout
  so pi can exit; the backend self-terminates on stdin EOF.

## 2026-08-15 (shared backend.ts)

- Testing extension glue with `bun -e` or `bun script.mjs` throws `TypeError:
  child.stdin.unref is not a function` while the same code works in pi:
  pi runs under real Node (shebang `#!/usr/bin/env node` in dist/cli.js),
  and bun's `node:child_process` shim lacks `unref` on child stdin. Load
  tests for extension code must run under `node`, with pi's module aliases
  (`typebox`, `@earendil-works/*`) mocked, because jiti cannot resolve them
  from a repo without node_modules.

## 2025-08-15: /lg "path is not defined"

The extensions/lib refactor (ff8e38e) moved backend spawning into
lib/backend.ts but dropped the `import path from "node:path"` from
extensions/lazygit.ts while the handler kept using `path.resolve`. No
typecheck or lint gate covers extensions/*.ts (bun build transpiles without
typechecking), so the ReferenceError only surfaced at runtime on the first
/lg after the refactor. Fix: re-add the import. Lesson: when editing the
extension glue, grep for bare node globals (`path.`, `process.`, `Buffer.`)
after any import shuffling, and consider a tsc --noEmit pass over
extensions/ as a hk step.

## 2026-05-13: pi rpc mode cannot service extension child-pipe I/O

- Any `await backend.call(...)` on a `createBackend` child in `pi --mode
  rpc` hangs forever: the backend responds (verified alive and healthy), but
  the response line never reaches the glue, and the pending promise never
  settles, even on child exit. Backends hang around as idle processes until
  pi exits. Affects every createBackend extension (commit, lg, browser,
  goal, peon). TUI mode is fine
- Workaround: guard commands that need the backend with `ctx.mode !== "tui"`
  and refuse before touching the backend

## 2026-08-15: Zig 0.16 API churn hit while writing pi-usage

- `std.posix` no longer exports `pipe`/`close`/`write`/`getpid`; use
  `posix.system.pipe(&fds)` / `posix.system.close(fd)` /
  `posix.system.write(fd, ptr, len)` / `posix.system.getpid()` and check
  returns via `posix.errno(...)` (they return raw errno c_int, and close/write
  return values must be discarded with `_ =`)
- `std.ArrayList(T)` is now the UNMANAGED list (init via `.empty`, methods
  take the allocator); the managed variant is
  `std.array_list.AlignedManaged(T, null)` (what common.zig's `List` uses).
  `std.Io.Writer.Allocating.fromArrayList` pairs with the unmanaged one
- File APIs moved to `std.Io.Dir`: `statFile(.cwd(), io, path, .{})` returns
  `Io.File.Stat` with `mtime: Io.Timestamp` (use `.toMilliseconds()`) and
  `.permissions` (a `Permissions` value, not `.mode`); `renameAbsolute`,
  `createFileAbsolute`, `readFileAlloc(.cwd(), io, path, arena, .limited(n))`
- `std.base64.url_safe_no_pad` is a `Codecs` value: the decoder field is
  capitalized (`.Decoder`), no `.decoder` member
- `json.Value` `.number` no longer exists for ints/floats: match `.integer`
  and `.float` separately
- `std.Thread.spawn` needs the ctx as `*T` (declare `var`, not `const`);
  an anonymous struct used as a fn return type must be a named type
- `error` is a reserved word: cannot be a struct field name (used `err`)

## 2026-08-15: Zig 0.16 std.net/http API traps while building pi-vision

- `std.Io.net.listen`/`connect` are methods on `Io.net.IpAddress`
  (`IpAddress.listen(&addr, io, opts)`), not on `Io.net`. They also take
  `*const IpAddress`, and `listen` returns a `var` (deinit takes `*Server`)
- `std.Io.Clock` has no `.monotonic`: members are `.real`, `.awake`, `.boot`
  (use `.awake` for sleeps)
- `mem.trimRight` is gone; `mem.trim` trims both ends
- `std.ArrayList(T)` is unmanaged: `.empty` + `append(alloc, item)`
- `std.http.Client.fetch` DISCARDS the body unless you pass a
  `response_writer`; `Io.Writer.fixed(buf)` + `writer.end` gives the written
  length. There is no request deadline anywhere in the client
- `std.Thread.Condition` no longer exists (no `timedWait` anywhere in std);
  the new `Io.Mutex`/`Io.Condition` have no timed wait either. For a
  request deadline, spawn a worker thread + poll an atomic with
  `Io.sleep`, and unblock a hung read with `stream.shutdown(io, .both)`
  from the main thread (macOS wakes the blocked reader)
- `http.Server.Request.readerExpectNone` returns `*Reader` (no error union)
- Debug allocator prints leaks at exit; the first deadline design leaked the
  worker structs on every timeout. Fixed by main-thread-only freeing after
  join, with a bounded wait for the worker post-shutdown
- sips defaults its OUTPUT format to the INPUT format, and its WebP writer is
  broken ("Can't write format: org.webmproject.webp"). Resizing a WebP
  without an explicit `-s format` fails, so the `-s format` flag must always
  be passed (jpeg/png/gif). Also: an alpha WebP comes back as PNG, so the
  data-URL mime must follow what sips produced, not the input mime
- VP8X chunk layout: flags at chunk+8, canvas width at chunk+12, height at
  chunk+15 (the header is 8 bytes, the payload 10). The first version read
  them 12 bytes too far (into the next chunk), which silently produced
  garbage dimensions and a wrong alpha flag for every extended WebP; only a
  real-file test caught it
## 2026-08-16

- Fixed the /reload staleness trap in `extensions/lib/backend.ts`: pi's
  `/reload` re-imports extension TS but never touched Zig binaries, and old
  backend processes were orphaned until pi exited (they only self-terminate
  on stdin EOF, which pi's held pipe fds prevented). The glue now rebuilds
  with `zig build` whenever any source is newer than the binary (failed
  builds throw instead of running stale code), and every extension registers
  `pi.on("session_shutdown", () => backend.kill())` to close stdin and
  SIGTERM the old child. Verified: `zig build` is skipped when current, so
  plain startup latency is unchanged.
- `git merge` refuses outright when a file the merge rewrites has uncommitted
  local changes ("Your local changes ... would be overwritten by merge"),
  even when the local diff and the merge both touch disjoint regions of the
  file.
  Fix: `git stash push`, merge, resolve, `git stash pop` — the pop
  auto-merges the local diff back in, and the working tree ends up identical
  to what you had.

## 2026-08-21 — backend lifecycle hardening

- `gpa.create(T)` returns uninitialized memory: adding a field to a struct
  that a worker thread writes via `workerFinish` must initialize it on
  every path (including the "field absent" path), or the first read of the
  unset field is garbage. Adding `usage_len` to `common.WorkerSlot` without
  zeroing it on the no-usage path panicked pi-search with an out-of-bounds
  index of ~2^63. Zero defaults only apply to struct literals, not
  `gpa.create`.
- Bun's `node:child_process` lacks `child.stdin.unref()` (only real node
  has it; pi itself runs under `/opt/homebrew/bin/node`). Any test harness
  for `extensions/lib/backend.ts` must run under node, not bun — under bun
  the unref dance throws at spawn.
- `std.Io.File.MultiReader` buffers each stream unboundedly (there is no
  per-stream cap); `toOwnedSlice(i)` hands over the accumulated bytes, and
  the caller must cap afterward. Fine for small outputs (git commit), wrong
  for unbounded streams.

## 2026-08-21

- Zig 0.16 `std.http.Client` streaming reads: the socket reader buffers
  internally, and when response head + body arrive in one TCP segment (the
  norm on loopback), the leftover bytes sit in `reader.buffered()` and a
  `readVec` call that refills that buffer returns 0. Treating 0 as EOF
  (or blocking on the next readVec) silently loses the buffered events.
  Fix in src/search.zig's SSE loop: drain `reader.buffered()` before each
  read, `toss()` what was consumed, and re-check it after any 0-return
  readVec. The flake only showed up as an intermittent results-mode timeout,
  ~50% of runs.

## 2026-08-15

- `PI_TIMING=1` startup timings are swallowed when the TUI runs: the timings
  print into the alternate screen buffer, then the teardown escape sequence
  wipes them. Run `PI_TIMING=1 pi -p "hi"` (print mode) and read stderr
  instead; the `extensions` namespace breaks down per-extension import cost.
- A no-op `zig build` (nothing stale) still costs ~230ms of process startup
  + manifest evaluation. The old per-binary staleness check in
  `extensions/lib/backend.ts` compared each binary against a project-wide
  newest-source mtime, so one edited file marked 8 of 10 binaries stale and
  each backend paid a full no-op build on every launch (~2s of startup).
  Fixed with a project-wide stamp (zig-out/.pi-build-stamp.json): the
  rebuild now runs at most once per source change.

## 2026-08-15 — browser extension: every tool call hung forever (protocol drift)

- `extensions/lib/backend.ts` (shared glue) sends `{"id":N,"op":"...",...}`
  on its wire; every other backend's `Request` struct parses `op`. But
  `src/browser.zig`'s `Request` parsed a `tool` field (an old pre-shared-glue
  protocol), so every real browser_* call failed with `MissingField`. The
  backend answered with the unmatchable id 0, the glue's pending map had no
  entry for it, and the caller's promise never settled: an infinite hang,
  no error, no log.
- What made it invisible: exercising `Browser.call` directly bypasses the
  wire protocol, and my first harness drove the binary with the documented
  `tool` format instead of reading what the glue actually sends. The bug
  only shows through the real
  glue (Node) or by sending `op` yourself. Repro: feed the backend
  `{"id":5,"op":"goto","params":"{}"}` and watch it reply
  `{"id":0,"ok":false,"error":"MissingField"}` while the caller waits.
- Fixed: renamed the field to `op` in `src/browser.zig` (+ protocol comments,
  `docs/architecture.md`), and hardened `extensions/lib/backend.ts` to log
  responses with unknown ids / non-JSON lines to stderr instead of dropping
  them silently, so a future protocol drift fails loudly instead of hanging.
- Lesson: test the glue's actual wire bytes, not the documented ones; and
  when a tool hangs forever with no error, check the backend's id-0 replies.

## 2026-08-15 — Exa search rewrite

- Sourcing `~/.zshrc` inside a bash tool session dies silently before the
  next command runs: the `eval "$(fnox activate zsh)"` and `eval "$(mise
  activate zsh)"` hooks plus zsh-only syntax (`autoload`, `bindkey`,
  `(( ... ))`) abort the whole script under bash, and earlier commands that
  did survive left the session in a broken state. Fix: don't source it,
  copy the needed export inline (`export EXA_API_KEY="..."`).
- Zig 0.16 `std.http` decompressing reader: `readVec` returning 0 means the
  reader's internal buffer was drained (bytes it had already pulled from
  the socket), not EOF. Breaking on 0 truncated the Exa response body and
  made the parse fail with "not valid JSON"; only `error.EndOfStream` is
  EOF. Fix: keep looping, re-check `reader.buffered()` after a 0-return
  read (same quirk as the old SSE loop, now hit on a plain full-body read).
- `std.ArrayList` (unmanaged) takes the allocator per call
  (`appendSlice(alloc, items)`); `common.List` is the managed variant and
  takes no allocator argument. Using the managed `List` with the unmanaged
  call shape fails to compile.

## 2026-08-15 — pi-cua extension (Cua Driver)

- `cua-driver call` exit codes are unreliable: `invalid_arguments` exits 0
  with an in-band JSON error on stdout, unknown tools exit 1 with the
  message on stderr, and `window_id_not_found` exits non-zero with JSON on
  stdout. Judge success by stdout content (non-empty = result, in-band
  `code` payloads pass through to the model), never by the exit code.
- The docs claim `--screenshot-out-file` makes get_window_state respond
  with `screenshot_file_path`; the real 0.20.0 CLI omits the key entirely.
  Track the path yourself (the backend chose it).
- `cua-driver call <tool>` reads stdin when it is piped (it waits for JSON
  args) — a spawned child must get `/dev/null` stdin (`.ignore` in Zig
  0.16 spawn), which the CLI tolerates, or it blocks forever on the
  parent's open pipe.
- The tool input schemas admit fields the CLI rejects at runtime
  (`additionalProperties: false`, e.g. list_apps has no properties at
  all); unknown fields come back as in-band `invalid_arguments` JSON, so
  glue schemas must match the MCP argument names exactly
  (`cua-driver describe <tool>` is the source of truth).
- `list_apps` ignores a `{"name":...}` filter (no such schema field); the
  CLI silently ignores the extra field instead of rejecting it.
- `std.StringHashMap` does NOT copy key memory in Zig 0.16 ("Key memory is
  managed by the caller"). Keys built in a stack buffer (e.g.
  `std.fmt.bufPrint`) and then `put` into the map silently point at
  reused stack slots once the buffer goes out of scope - lookups then
  miss or hit the wrong entry, and `grow` panics on the duplicate. Dupe
  keys into an arena before `put`. Diagnosed via a map-iterator debug
  print showing two entries with the same key.
- A `b.addRunArtifact` run does not refresh `zig-out/bin/<name>`: the run
  artifact goes to the build cache, so hand-testing the installed binary
  after a source change runs a stale build (panics/old behavior). Run
  `zig build` first to install the new binary, then exercise it.

## 2026-08-17

- Driving `createBackend` logic with a standalone harness: `extensions/lib/backend.ts` is TypeScript for pi which runs under Node (`#!/usr/bin/env node`), not Bun, so harnesses must transpile (`bun build --target=node`) and run under `node`, placed at `extensions/lib/` so `import.meta.dirname`-based root resolution lands on the repo. The unref'd child+pipes mean a harness with no ref'd handles exits before pipe I/O completes ("unsettled top-level await"): add a `setInterval(() => {}, 1000)` keep-alive. Also: `bun build` emits `+ \`\n\`` for `+ "\n"` as a template literal with a real newline, so textual patches around the write line land inside the string and corrupt the payload.

- TypeScript 6.0 flips `strict` on by default (tsconfigs that omit it are strict), and it no longer infers `never` for un-annotated throwing functions, so `return throwFn()` poisons an async function's inferred return into `void | T` and breaks tool-executor registration against `AgentToolResult`. Annotate the thrower as `: never`. Diagnosed by bisecting a repro against the real pi types; TS 5.9 does not have either behavior.
- tsconfig `paths` does not consult the target package's `exports` map: `@earendil-works/pi-ai/compat` mapped to the package dir fails because the file lives at `dist/compat.d.ts`. A package-specific entry mapping `@earendil-works/pi-ai/*` into `dist/` fixes subpath imports. Order does not matter, TS falls through a pattern whose target does not resolve to the next one (verified after `jq -S` reordered the entries).
- `hk fix -S jq -S newlines` on a new tsconfig.json: the write tool emits no trailing newline (newlines step fails) and `Builtins.jq` (`jq -S`) wants multi-line array formatting, so a fresh JSON file fails the check until both fixers run once.
- `bun`'s global install serves as the type source: `strict: false` + `paths` + `typeRoots` pointing at `~/.bun/install/global/node_modules` give the extension glue its types with no local `node_modules`, but the config is machine-specific and breaks on any clone lacking that install (documented in docs/architecture.md).

## 2026-08-18 — one-shot conversion (pi-search)

- Zig 0.16 format strings: a literal `{` in a `print` format string must be
  `{{` even when it is the JSON envelope opener. `buf.print("{\"ok\":true,
  \"result\":\"", .{})` fails to compile with "missing closing }" in
  `std/Io/Writer.zig`; the existing code always used `{{` for the envelope
  and the one-shot `respondExit`/`respondOutcomeExit` additions in
  common.zig initially forgot it on one line. Any hand-built envelope in a
  format string needs `{{`/`}}`, plain `appendSlice` is fine.
- A multi-edit `edit` call is atomic: when one `oldText` matches multiple
  locations (the search "unrefs the backend child" note appears in three
  extension sections of docs/architecture.md), the whole call is rejected
  and NONE of the edits apply, including the ones that were unique. After
  a rejected multi-edit, grep to confirm nothing partial landed before
  re-submitting with unique context anchors.
- `pi.exec` result shape quirk: on a signal death (timeout or abort) the
  exit `code` comes back as 0 with `killed: true` (the code is null for
  signal terminations and execCommand substitutes 0), so the glue must
  check `res.killed` before trusting the exit code, or a killed process
  looks like an empty success. Handled in extensions/lib/zig.ts.

## 2026-08-18 — one-shot conversion (pi-lg)

- `cd` persists across `bash` tool calls in this harness. In one smoke-test
  batch I ran `cd /tmp` to test the not-a-repo path and the subsequent
  relative-path `./zig-out/bin/pi-lg` invocations failed with "No such file
  or directory". Use absolute binary paths (or `pushd`/`popd`) in multi-step
  test commands.
- macOS has no GNU `timeout` (`timeout: command not found`). To bound a
  blocking backend binary that opens `/dev/tty`, bg it, `sleep`, `kill`,
  then `wait` — or rely on the op failing fast when no controlling terminal
  exists (this sandbox has none, so `run` returned "cannot open controlling
  terminal /dev/tty" immediately, which conveniently exercised the full run
  path including the signal-handler install without needing a real tty).
