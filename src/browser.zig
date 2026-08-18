// pi-browser: headless browser backend for the pi coding agent.
//
// Spawns `lightpanda mcp` as a child process and speaks MCP (JSON-RPC 2.0
// over stdio, newline-delimited) to it. The pi extension (extensions/browser.ts)
// sends one JSON request per line on stdin, we forward it as an MCP tools/call,
// and write one JSON response line to stdout.
//
// Request line:  {"id":1,"op":"goto","params":"{\"url\":\"...\"}"}
//                 (params is a JSON string containing a raw JSON object)
// Response line: {"id":1,"ok":true,"result":"..."}  or  {"id":1,"ok":false,"error":"..."}
//
// Only std.posix is used for IO (fork/exec/pipes/read/write), which is stable
// across Zig versions and avoids the std.Io refactor.

const std = @import("std");
const posix = std.posix;
const mem = std.mem;
const json = std.json;
const Allocator = std.mem.Allocator;
const common = @import("common.zig");
const List = common.List;
const nowMs = common.nowMs;
const readLine = common.readLine;
const writeAllIo = common.writeAllIo;
const respond = common.respond;

const MAX_LINE = 64 * 1024 * 1024; // hard cap on a single message line

// Cap on the extracted text returned to the glue. The protocol limit is
// 64MB, but one html/tree/evaluate result at that size would flood the
// model's context and bloat the session file, so extractions are truncated
// to a small default with the head and tail preserved.
const MAX_RESULT = 256 * 1024;

// Backstop for a single MCP tool call. Lightpanda runs its own (far shorter)
// timeouts for navigation, waits, and evaluate, so this only fires when a
// transfer stalls. We disable lightpanda's http timeout (--http-timeout 0)
// because it is applied to websockets too and kills idle persistent
// connections (webpack HMR, supabase realtime, ...), which makes pages
// reconnect in an endless loop. With it disabled, this deadline is what
// keeps a stalled transfer from hanging the backend forever.
const CALL_TIMEOUT_MS: i64 = 120_000;

var g_terminate = std.atomic.Value(bool).init(false);

const Request = struct {
    id: i64,
    op: []const u8, // MCP tool name, e.g. "goto"; the shared glue sends `op`
    params: []const u8, // JSON string containing the raw arguments object
};

// Truncates extracted text over MAX_RESULT to its head and tail with an
// explicit marker, so the model still sees the start and end of the page.
fn capResult(arena: Allocator, text: []const u8) ![]const u8 {
    if (text.len <= MAX_RESULT) return text;
    const head_len = MAX_RESULT * 3 / 4;
    const tail_len = MAX_RESULT - head_len;
    return std.fmt.allocPrint(arena, "{s}\n\n… [{d} bytes truncated] …\n\n{s}", .{ text[0..head_len], text.len - MAX_RESULT, text[text.len - tail_len ..] });
}

const CallResult = struct {
    ok: bool,
    text: []const u8,
};

const Browser = struct {
    io: std.Io,
    child: std.process.Child,
    in_file: std.Io.File, // parent -> child (requests)
    out_file: std.Io.File, // child -> parent (responses)
    next_id: i64 = 1,
    line_buf: List, // leftover bytes between lines
    stderr_thread: ?std.Thread = null,

    fn spawn(io: std.Io, line_alloc: Allocator) !Browser {
        // --http-timeout 0: lightpanda applies its http transfer timeout to
        // websocket connections too (it never resets it after the upgrade),
        // so the default 5s cap kills idle persistent sockets, pages
        // auto-reconnect, and the cycle repeats forever. CALL_TIMEOUT_MS in
        // call() replaces it as the bound on our side.
        const child = try std.process.spawn(io, .{
            .argv = &.{ "lightpanda", "mcp", "--http-timeout", "0" },
            .stdin = .pipe,
            .stdout = .pipe,
            .stderr = .pipe,
        });
        var b = Browser{
            .io = io,
            .child = child,
            .in_file = child.stdin.?,
            .out_file = child.stdout.?,
            .line_buf = List.init(line_alloc),
        };
        errdefer b.deinit();
        // Drain lightpanda's stderr on a background thread and forward only
        // error/fatal lines to our stderr. Inheriting it directly flooded
        // the TUI: pages drive warn/info noise (websocket reconnects,
        // console.* calls) that lightpanda logs by default.
        b.stderr_thread = std.Thread.spawn(.{}, stderrForwarder, .{b.child.stderr.?.handle}) catch null;
        try b.handshake();
        return b;
    }

    fn deinit(b: *Browser) void {
        // lightpanda mcp ignores SIGTERM and exits only on stdin EOF, so close
        // our end of its stdin pipe first (and null the child's field so its
        // cleanup does not close the fd a second time), then signal and reap.
        b.in_file.close(b.io);
        b.child.stdin = null;
        // Closing the stderr pipe makes the forwarder thread's blocking read
        // fail, so it exits; join before freeing anything it touches.
        if (b.child.stderr) |stderr_file| {
            stderr_file.close(b.io);
            b.child.stderr = null;
        }
        if (b.stderr_thread) |t| t.join();
        b.child.kill(b.io);
        b.line_buf.deinit();
    }

    fn handshake(b: *Browser) !void {
        const init = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"pi-browser\",\"version\":\"0.1.0\"}}}\n";
        try writeAllIo(b.io, b.in_file, init);
        _ = try readLine(b.out_file.handle, &b.line_buf, MAX_LINE, null, null) orelse return error.McpClosed;
        // we do not check the response contents, just that it came back
        try writeAllIo(b.io, b.in_file, "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n");
    }

    // Sends one MCP tools/call and returns the extracted text result.
    // `arena` must outlive the returned slice; pass null to use the process allocator.
    fn call(b: *Browser, arena: ?Allocator, tool: []const u8, params: []const u8) !CallResult {
        const alloc = arena orelse std.heap.page_allocator;
        const id = b.next_id;
        b.next_id += 1;
        const req = try std.fmt.allocPrint(alloc, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"method\":\"tools/call\",\"params\":{{\"name\":\"{s}\",\"arguments\":{s}}}}}\n", .{ id, tool, params });
        try writeAllIo(b.io, b.in_file, req);

        const deadline = nowMs() + CALL_TIMEOUT_MS;

        while (try readLine(b.out_file.handle, &b.line_buf, MAX_LINE, arena, deadline)) |line| {
            const parsed = json.parseFromSlice(json.Value, alloc, line, .{ .ignore_unknown_fields = true }) catch |err| return err;
            const obj = parsed.value.object;
            const msg_id = obj.get("id") orelse continue;
            if (msg_id != .integer or msg_id.integer != id) continue;

            if (obj.get("error")) |err_obj| {
                const msg = err_obj.object.get("message") orelse return error.McpError;
                return .{ .ok = false, .text = msg.string };
            }
            const result = obj.get("result") orelse return error.McpBadResponse;
            if (result == .string) return .{ .ok = true, .text = try capResult(alloc, result.string) };

            const ro = result.object;
            const is_err = if (ro.get("isError")) |v| v.bool else false;
            var out = List.init(alloc);
            if (ro.get("content")) |content| {
                for (content.array.items) |item| {
                    if (item != .object) continue;
                    const io = item.object;
                    const t = io.get("type") orelse continue;
                    if (t != .string or !mem.eql(u8, t.string, "text")) continue;
                    if (io.get("text")) |text| try out.appendSlice(text.string);
                }
            }
            return .{ .ok = !is_err, .text = try capResult(alloc, out.items) };
        }
        return error.McpClosed;
    }
};

// Reads lightpanda's stderr and forwards only error/fatal log lines to our
// stderr. Everything below error is suppressed: pages drive warn/info noise
// (websocket reconnect failures, console.* calls) that would otherwise
// flood the TUI. Lightpanda logfmt lines carry "$level="; any other output
// is dropped too.
fn stderrForwarder(fd: posix.fd_t) void {
    var line_buf = List.init(std.heap.page_allocator);
    defer line_buf.deinit();
    var arena_state = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena_state.deinit();
    while (true) {
        _ = arena_state.reset(.retain_capacity);
        const line = readLine(fd, &line_buf, MAX_LINE, arena_state.allocator(), null) catch return;
        if (line) |l| {
            if (mem.indexOf(u8, l, "$level=error") != null or mem.indexOf(u8, l, "$level=fatal") != null) {
                std.debug.print("{s}\n", .{l});
            }
        } else return;
    }
}

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;

    const S = struct {
        fn handler(_: posix.SIG) callconv(.c) void {
            g_terminate.store(true, .seq_cst);
        }
    };
    const sa = posix.Sigaction{
        .handler = .{ .handler = S.handler },
        .mask = posix.sigemptyset(),
        .flags = 0,
    };
    posix.sigaction(posix.SIG.TERM, &sa, null);
    posix.sigaction(posix.SIG.INT, &sa, null);

    var browser = Browser.spawn(io, gpa) catch |err| {
        std.debug.print("pi-browser: failed to start lightpanda mcp: {s}\n", .{@errorName(err)});
        return err;
    };
    defer browser.deinit();

    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    var stdin_buf = List.init(gpa);
    defer stdin_buf.deinit();

    while (!g_terminate.load(.seq_cst)) {
        _ = arena_state.reset(.retain_capacity);
        const arena = arena_state.allocator();

        const line = readLine(posix.STDIN_FILENO, &stdin_buf, MAX_LINE, arena, null) catch |err| {
            std.debug.print("pi-browser: {s}\n", .{@errorName(err)});
            break;
        } orelse break;
        if (line.len == 0) continue;

        const req = json.parseFromSlice(Request, arena, line, .{ .ignore_unknown_fields = true }) catch |err| {
            respond(arena, io, 0, false, @errorName(err)) catch {};
            continue;
        };

        const res = browser.call(arena, req.value.op, req.value.params) catch |err| CallResult{
            .ok = false,
            .text = @errorName(err),
        };
        respond(arena, io, req.value.id, res.ok, res.text) catch {};
    }
}
