# Papercuts

## 2026-08-13

- `zig build run -- --self-check` does not update `zig-out/bin/pi-browser`:
  `addRunArtifact` runs from the build cache, only `installArtifact` writes
  zig-out. After editing `src/`, run plain `zig build` before driving the
  binary directly, or you test a stale build (cost a full repro cycle while
  debugging the browser log spam).
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

## 2026-05-13: pi-wt backend Zig 0.16 API surprises

- `std.crypto.random` does not exist in 0.16 (removed). Had to seed the name
  generator from `nowMs()` mixed with a stack address
- `std.ArrayList(T).init(alloc)` is gone: `std.ArrayList` is now the
  unmanaged `array_list.Aligned`, so use `.empty` + `append(alloc, item)`
- `json.parseFromSlice(...).value` must be accessed as `parsed.value`, and
  `dir ++ "/suffix"` only works for comptime slices, so path assertions in
  self-checks need `allocPrint`
- `/tmp` on macOS is a symlink to `/private/tmp`: git canonicalizes the
  worktree root, so self-check assertions must compare against
  `git rev-parse --show-toplevel`, not the raw temp dir

## 2026-05-13: pi rpc mode cannot service extension child-pipe I/O

- Any `await backend.call(...)` on a `createBackend` child in `pi --mode
  rpc` hangs forever: the backend responds (verified alive and healthy), but
  the response line never reaches the glue, and the pending promise never
  settles, even on child exit. Backends hang around as idle processes until
  pi exits. Affects every createBackend extension (commit, lg, browser,
  goal, peon, wt), not just wt. TUI mode is fine
- Workaround: guard commands that need the backend with `ctx.mode !== "tui"`
  and refuse before touching the backend, which is what `/wt` does

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
  worker structs on every timeout, which showed up as noise in self-check
  output. Fixed by main-thread-only freeing after join, with a bounded
  wait for the worker post-shutdown
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
  file (docs/architecture.md: local wt-section edits vs branch appends).
  Fix: `git stash push`, merge, resolve, `git stash pop` — the pop
  auto-merges the local diff back in, and the working tree ends up identical
  to what you had. The /wt dirty-worktree reporting work in src/wt.zig makes
  the error friendlier but cannot fix the underlying refusal.

## 2026-08-21

- Zig 0.16 `std.http.Client` streaming reads: the socket reader buffers
  internally, and when response head + body arrive in one TCP segment (the
  norm on loopback), the leftover bytes sit in `reader.buffered()` and a
  `readVec` call that refills that buffer returns 0. Treating 0 as EOF
  (or blocking on the next readVec) silently loses the buffered events.
  Fix in src/search.zig's SSE loop: drain `reader.buffered()` before each
  read, `toss()` what was consumed, and re-check it after any 0-return
  readVec. The flake only showed up as an intermittent results-mode timeout
  in the self-check, ~50% of runs.

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
