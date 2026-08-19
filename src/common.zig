// pi-common: IO, JSON, and process helpers shared by the extension backends.
//
// Every backend here is one-shot: one JSON request as a single argv element,
// one JSON response envelope on stdout, exit 0/1. These helpers are the
// shared part of that (line reader with deadline, buffered writer,
// JSON-escaped responder, process runner, HTTP-with-deadline worker). Each
// backend keeps its own request parsing, op dispatch, and protocol structs.

const std = @import("std");
const posix = std.posix;
const mem = std.mem;
const json = std.json;
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

// Epoch wall clock in milliseconds, comparable to the glue's wall time
// (Date.now()), unlike the monotonic nowMs.
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

// ---------------------------------------------------------------------------
// One-shot response helpers (shared by the one-shot backends)

// Result of a one-shot backend op. The search/vision-style backends
// return one of these from every op and dispatch on ok/text/err via
// respondOutcomeExit. `usage` is an optional pre-serialized JSON object
// appended to the success response line (vision/search report the delegated
// model's token accounting there).
pub const Outcome = struct {
    ok: bool = false,
    err: []const u8 = "",
    text: []const u8 = "",
    usage: ?[]const u8 = null,
};

pub fn failOutcome(arena: Allocator, comptime fmt: []const u8, args: anytype) !Outcome {
    return .{ .ok = false, .err = try std.fmt.allocPrint(arena, fmt, args) };
}

// One-shot response: prints {"ok":true,"result":"..."} |
// {"ok":false,"error":"..."} and exits 0/1. There is no id: one request
// per process, so responses are self-addressing.
pub fn respondExit(alloc: Allocator, io: std.Io, ok: bool, text: []const u8) noreturn {
    var buf = List.init(alloc);
    buf.print("{{\"ok\":{s},\"{s}\":\"", .{ if (ok) "true" else "false", if (ok) "result" else "error" }) catch {};
    appendJsonEscaped(&buf, text) catch {};
    buf.appendSlice("\"}\n") catch {};
    writeAllIo(io, std.Io.File.stdout(), buf.items) catch {};
    std.process.exit(if (ok) 0 else 1);
}

// One-shot response dispatch for an Outcome: ok -> result text, else error.
// A non-null usage is appended to the ok line as "","usage":<json>.
pub fn respondOutcomeExit(arena: Allocator, io: std.Io, outcome: Outcome) noreturn {
    if (outcome.usage) |u| {
        var buf = List.init(arena);
        buf.print("{{\"ok\":true,\"result\":\"", .{}) catch {};
        appendJsonEscaped(&buf, outcome.text) catch {};
        buf.appendSlice("\",\"usage\":") catch {};
        buf.appendSlice(u) catch {};
        buf.appendSlice("}\n") catch {};
        writeAllIo(io, std.Io.File.stdout(), buf.items) catch {};
        std.process.exit(0);
    }
    respondExit(arena, io, outcome.ok, if (outcome.ok) outcome.text else outcome.err);
}

// ---------------------------------------------------------------------------
// HTTP call with deadline (shared by pi-vision, pi-search, pi-lightpanda)
//
// Both backends POST to a remote endpoint on a worker thread so a hung
// provider cannot stall the main loop. The worker runs with its own arena
// (it must dupe any caller-arena strings before use), writes the result into
// the shared slot's fixed buffers, and signals done. The main thread waits
// with a deadline; on expiry it shuts down the worker's socket (slot.fd) so
// the worker unblocks, waits up to 1s for it to exit, and joins. If the
// worker is still stuck (connect/TLS handshake before registering its
// socket), the main thread abandons it: the wrapper frees the heap structs
// itself when the worker eventually finishes, so repeated slow connections
// cannot accumulate threads or allocations.

pub const MAX_RESULT_TEXT = 64 * 1024; // cap on the result copied out of the slot
pub const MAX_ERR_TEXT = 2048; // cap on the error text copied out of the slot
pub const MAX_USAGE_TEXT = 2048; // cap on the usage JSON copied out of the slot

pub const WorkerSlot = struct {
    done: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
    // Set by the main thread only when it abandons the worker on a deadline
    // (worker stuck before registering its socket); the worker then frees its
    // own heap structs. Never set on the join path, so the worker only frees
    // when the main thread is guaranteed not to.
    abandoned: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
    fd: std.atomic.Value(posix.fd_t) = std.atomic.Value(posix.fd_t).init(-1),
    ok: bool = false,
    retryable: bool = false,
    text: [MAX_RESULT_TEXT]u8 = undefined,
    text_len: usize = 0,
    usage: [MAX_USAGE_TEXT]u8 = undefined,
    usage_len: usize = 0,
    err: [MAX_ERR_TEXT]u8 = undefined,
    err_len: usize = 0,
};

pub const HttpOutcome = struct {
    ok: bool,
    retryable: bool,
    text: []const u8,
    err: []const u8,
    usage: ?[]const u8 = null, // pre-serialized JSON object, when the worker reported one
};

pub fn workerFinish(slot: *WorkerSlot, ok: bool, retryable: bool, text: []const u8) void {
    workerFinishUsage(slot, ok, retryable, text, null);
}

// Same as workerFinish, with an optional pre-serialized usage JSON object
// (e.g. the provider's token accounting) carried alongside a successful
// result.
pub fn workerFinishUsage(slot: *WorkerSlot, ok: bool, retryable: bool, text: []const u8, usage: ?[]const u8) void {
    slot.ok = ok;
    slot.retryable = retryable;
    slot.usage_len = 0;
    if (ok) {
        const n = @min(text.len, MAX_RESULT_TEXT - 1);
        @memcpy(slot.text[0..n], text[0..n]);
        slot.text_len = n;
        if (usage) |u| {
            const un = @min(u.len, MAX_USAGE_TEXT - 1);
            @memcpy(slot.usage[0..un], u[0..un]);
            slot.usage_len = un;
        }
    } else {
        const n = @min(text.len, MAX_ERR_TEXT - 1);
        @memcpy(slot.err[0..n], text[0..n]);
        slot.err_len = n;
    }
    slot.done.store(true, .release);
}

pub fn isRetryableStatus(code: u16) bool {
    return code == 429 or (code >= 500 and code <= 599);
}

pub fn isRetryableErr(err: anyerror) bool {
    return switch (err) {
        error.ConnectionRefused,
        error.ConnectionResetByPeer,
        error.NetworkUnreachable,
        error.HostUnreachable,
        error.TlsInitializationFailed,
        error.CertificateBundleLoadFailure,
        error.EndOfStream,
        error.BrokenPipe,
        error.WriteFailed,
        => true,
        else => false,
    };
}

// Parses the glue's JSON header list ("[[\"h\",\"v\"],...]") into pairs.
pub fn parseHeaders(arena: Allocator, s: ?[]const u8) ![]const [2][]const u8 {
    const h = s orelse return &.{};
    if (h.len == 0) return &.{};
    return json.parseFromSliceLeaky([][2][]const u8, arena, h, .{ .ignore_unknown_fields = true });
}

// Spawned wrapper around the user worker: after it finishes, the wrapper
// frees the heap structs when the main thread abandoned us (deadline expiry
// while we were stuck before registering the socket). The main thread never
// frees in that path, so there is exactly one owner. On the join path the
// flag is never set and the main thread frees after join.
fn workerMain(comptime Ctx: type, comptime userWorker: fn (*Ctx, *WorkerSlot) void, heap_ctx: *Ctx, slot: *WorkerSlot, gpa: Allocator) void {
    userWorker(heap_ctx, slot);
    if (slot.abandoned.load(.acquire)) {
        gpa.destroy(heap_ctx);
        gpa.destroy(slot);
    }
}

// Spawns `worker` on a thread with a heap copy of `ctx` plus the shared
// slot, waits up to `timeout_ms`, and returns the worker's result. On
// timeout the worker's socket is shut down (unblocking its read); see the
// section comment for the lifecycle. `worker` must be a function of
// (ctx_type, *WorkerSlot).
pub fn httpWithDeadline(
    gpa: Allocator,
    arena: Allocator,
    io: std.Io,
    ctx: anytype,
    comptime worker: fn (*@TypeOf(ctx), *WorkerSlot) void,
    timeout_ms: u32,
) !HttpOutcome {
    const ctx_type = @TypeOf(ctx);
    const heap_ctx = try gpa.create(ctx_type);
    heap_ctx.* = ctx;
    const slot = try gpa.create(WorkerSlot);

    const thread = std.Thread.spawn(.{}, workerMain, .{ ctx_type, worker, heap_ctx, slot, gpa }) catch |err| {
        gpa.destroy(heap_ctx);
        gpa.destroy(slot);
        return err;
    };

    const deadline = nowMs() + @as(i64, timeout_ms);
    while (true) {
        if (slot.done.load(.acquire)) break;
        const remaining = deadline - nowMs();
        if (remaining <= 0) {
            // Deadline hit: shut down the worker's socket so its blocked read
            // unblocks, wait up to 1s for it to exit, and clean up when it
            // does. If it is still stuck (connect/TLS handshake before the
            // socket was registered), hand ownership to it: the worker frees
            // the heap structs when it eventually finishes, so repeated slow
            // connections cannot accumulate threads or allocations.
            const fd = slot.fd.load(.monotonic);
            if (fd >= 0) {
                const stream: std.Io.net.Stream = .{ .socket = .{ .handle = fd, .address = .{ .ip4 = .{ .bytes = .{ 0, 0, 0, 0 }, .port = 0 } } } };
                stream.shutdown(io, .both) catch {};
            }
            var waited: i64 = 0;
            while (!slot.done.load(.acquire) and waited < 1000) : (waited += 10) {
                std.Io.sleep(io, std.Io.Duration.fromMilliseconds(10), .awake) catch {};
            }
            if (slot.done.load(.acquire)) {
                thread.join();
                gpa.destroy(heap_ctx);
                gpa.destroy(slot);
            } else {
                // The worker is stuck pre-socket; it frees its own memory on
                // exit (workerMain), so this path joins nothing and frees
                // nothing.
                slot.abandoned.store(true, .release);
                thread.detach();
            }
            return error.TimedOut;
        }
        std.Io.sleep(io, std.Io.Duration.fromMilliseconds(@min(remaining, 50)), .awake) catch {};
    }
    thread.join();

    const out: HttpOutcome = if (slot.ok)
        .{ .ok = true, .retryable = false, .text = try arena.dupe(u8, slot.text[0..slot.text_len]), .err = "", .usage = if (slot.usage_len > 0) try arena.dupe(u8, slot.usage[0..slot.usage_len]) else null }
    else
        .{ .ok = false, .retryable = slot.retryable, .text = "", .err = try arena.dupe(u8, slot.err[0..slot.err_len]) };
    gpa.destroy(heap_ctx);
    gpa.destroy(slot);
    return out;
}
