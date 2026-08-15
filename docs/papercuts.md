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
