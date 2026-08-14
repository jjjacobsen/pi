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
