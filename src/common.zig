// pi-common: IO, JSON, and process helpers shared by the extension backends.
//
// Every backend speaks the same protocol to its TS glue: one JSON request
// line on stdin, one JSON response line on stdout. These helpers are the
// shared part of that protocol (line reader with deadline, buffered writer,
// JSON-escaped responder, process runner). Each backend keeps its own
// request parsing, op dispatch, protocol structs, and self-check.

const std = @import("std");
const posix = std.posix;
const mem = std.mem;
const Allocator = std.mem.Allocator;

pub const List = std.array_list.AlignedManaged(u8, null);

pub const CHUNK = 64 * 1024;

pub const GitResult = struct {
    ok: bool,
    stdout: []const u8,
    stderr: []const u8,
};

// Monotonic wall clock in milliseconds (std.time.milliTimestamp was removed
// in Zig 0.16; this is the remaining supported way to read a clock).
pub fn nowMs() i64 {
    var ts: posix.timespec = undefined;
    if (std.c.clock_gettime(std.c.CLOCK.MONOTONIC, &ts) != 0) return 0;
    return @as(i64, ts.sec) * 1000 + @divTrunc(@as(i64, ts.nsec), 1_000_000);
}

// Epoch wall clock in milliseconds. Goal deadlines must be comparable to the
// glue's wall time (Date.now()), so goal.zig aliases this instead of nowMs.
pub fn nowRealtimeMs() i64 {
    var ts: std.c.timespec = undefined;
    if (std.c.clock_gettime(std.c.CLOCK.REALTIME, &ts) != 0) return 0;
    return @as(i64, ts.sec) * 1000 + @divTrunc(@as(i64, ts.nsec), 1_000_000);
}

// Reads one newline-delimited line from a fd. The returned slice is owned by
// `arena` (or page_allocator when null) and survives until the next call.
// Returns null on EOF. `line_buf` holds leftover bytes between calls and must
// be distinct per fd; `max_line` caps a single line. `deadline` is a
// wall-clock millisecond timestamp; when set and data has not arrived by
// then, returns error.Timeout. Pass null for no deadline.
pub fn readLine(fd: posix.fd_t, line_buf: *List, max_line: usize, arena: ?Allocator, deadline: ?i64) !?[]const u8 {
    const alloc = arena orelse std.heap.page_allocator;
    var consumed: usize = 0;
    while (true) {
        if (mem.indexOfScalar(u8, line_buf.items[consumed..], '\n')) |rel| {
            const idx = consumed + rel;
            const line = try alloc.dupe(u8, line_buf.items[0..idx]);
            consumed = idx + 1;
            if (consumed == line_buf.items.len) {
                line_buf.clearRetainingCapacity();
            } else {
                const rest = line_buf.items.len - consumed;
                mem.copyForwards(u8, line_buf.items[0..rest], line_buf.items[consumed..]);
                line_buf.shrinkRetainingCapacity(rest);
            }
            return line;
        }
        if (line_buf.items.len > max_line) return error.LineTooLong;
        if (deadline) |dl| {
            const remaining = dl - nowMs();
            if (remaining <= 0) return error.Timeout;
            var fds = [_]posix.pollfd{.{ .fd = fd, .events = posix.POLL.IN, .revents = 0 }};
            _ = posix.poll(&fds, @intCast(@min(remaining, 2147483647))) catch |err| return err;
            // Only proceed to read when there is data or the pipe is closed;
            // anything else (spurious wake) re-checks the deadline.
            if (fds[0].revents & (posix.POLL.IN | posix.POLL.ERR | posix.POLL.HUP) == 0) continue;
        }
        var chunk: [CHUNK]u8 = undefined;
        const n = try posix.read(fd, &chunk);
        if (n == 0) {
            if (line_buf.items.len == 0) return null;
            const line = try alloc.dupe(u8, line_buf.items);
            line_buf.clearRetainingCapacity();
            return line;
        }
        try line_buf.appendSlice(chunk[0..n]);
    }
}

pub fn writeAllIo(io: std.Io, file: std.Io.File, bytes: []const u8) !void {
    var wbuf: [8192]u8 = undefined;
    var w = std.Io.File.writerStreaming(file, io, &wbuf);
    try w.interface.writeAll(bytes);
    try w.flush();
}

pub fn appendJsonEscaped(buf: *List, s: []const u8) !void {
    for (s) |c| {
        switch (c) {
            '"' => try buf.appendSlice("\\\""),
            '\\' => try buf.appendSlice("\\\\"),
            '\n' => try buf.appendSlice("\\n"),
            '\r' => try buf.appendSlice("\\r"),
            '\t' => try buf.appendSlice("\\t"),
            0...8, 11...12, 14...31 => try buf.print("\\u{x:0>4}", .{c}),
            else => try buf.append(c),
        }
    }
}

pub fn respond(alloc: Allocator, io: std.Io, id: i64, ok: bool, text: []const u8) !void {
    var buf = List.init(alloc);
    try buf.print("{{\"id\":{d},\"ok\":{s},\"{s}\":\"", .{ id, if (ok) "true" else "false", if (ok) "result" else "error" });
    try appendJsonEscaped(&buf, text);
    try buf.appendSlice("\"}\n");
    try writeAllIo(io, std.Io.File.stdout(), buf.items);
}

// Runs a command and captures stdout/stderr, capped by max_out. A spawn or
// stream failure becomes ok=false with the error name as stderr, so callers
// never have to handle the error union.
pub fn runCmd(arena: Allocator, io: std.Io, argv: []const []const u8, max_out: usize) !GitResult {
    const res = std.process.run(arena, io, .{
        .argv = argv,
        .stdout_limit = .limited(max_out),
        .stderr_limit = .limited(16 * 1024),
    }) catch |err| {
        return .{ .ok = false, .stdout = "", .stderr = @errorName(err) };
    };
    const ok = res.term == .exited and res.term.exited == 0;
    return .{ .ok = ok, .stdout = res.stdout, .stderr = res.stderr };
}

pub fn gitRoot(arena: Allocator, io: std.Io, cwd: []const u8) !?[]const u8 {
    const res = try runCmd(arena, io, &.{ "git", "-C", cwd, "rev-parse", "--show-toplevel" }, 4096);
    if (!res.ok) return null;
    const root = mem.trim(u8, res.stdout, " \t\r\n");
    if (root.len == 0) return null;
    return root;
}
