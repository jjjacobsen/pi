// pi-browser: headless browser backend for the pi coding agent.
//
// Spawns `lightpanda mcp` as a child process and speaks MCP (JSON-RPC 2.0
// over stdio, newline-delimited) to it. The pi extension (extensions/browser.ts)
// sends one JSON request per line on stdin, we forward it as an MCP tools/call,
// and write one JSON response line to stdout.
//
// Request line:  {"id":1,"tool":"goto","params":"{\"url\":\"...\"}"}
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
const List = std.array_list.AlignedManaged(u8, null);

const MAX_LINE = 64 * 1024 * 1024; // hard cap on a single message line
const CHUNK = 64 * 1024;

var g_terminate = std.atomic.Value(bool).init(false);

const Request = struct {
    id: i64,
    tool: []const u8,
    params: []const u8, // JSON string containing the raw arguments object
};

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

    fn spawn(io: std.Io, line_alloc: Allocator) !Browser {
        const child = try std.process.spawn(io, .{
            .argv = &.{ "lightpanda", "mcp" },
            .stdin = .pipe,
            .stdout = .pipe,
            .stderr = .inherit,
        });        var b = Browser{
            .io = io,
            .child = child,
            .in_file = child.stdin.?,
            .out_file = child.stdout.?,
            .line_buf = List.init(line_alloc),
        };
        errdefer b.deinit();
        try b.handshake();
        return b;
    }

    fn deinit(b: *Browser) void {
        // lightpanda mcp ignores SIGTERM and exits only on stdin EOF, so close
        // our end of its stdin pipe first (and null the child's field so its
        // cleanup does not close the fd a second time), then signal and reap.
        b.in_file.close(b.io);
        b.child.stdin = null;
        b.child.kill(b.io);
        b.line_buf.deinit();
    }

    fn handshake(b: *Browser) !void {
        const init = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"pi-browser\",\"version\":\"0.1.0\"}}}\n";
        try writeAllIo(b.io, b.in_file, init);
        _ = try readLine(b.out_file.handle, &b.line_buf, null) orelse return error.McpClosed;
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

        while (try readLine(b.out_file.handle, &b.line_buf, arena)) |line| {
            const parsed = json.parseFromSlice(json.Value, alloc, line, .{ .ignore_unknown_fields = true }) catch |err| return err;
            const obj = parsed.value.object;
            const msg_id = obj.get("id") orelse continue;
            if (msg_id != .integer or msg_id.integer != id) continue;

            if (obj.get("error")) |err_obj| {
                const msg = err_obj.object.get("message") orelse return error.McpError;
                return .{ .ok = false, .text = msg.string };
            }
            const result = obj.get("result") orelse return error.McpBadResponse;
            if (result == .string) return .{ .ok = true, .text = result.string };

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
            return .{ .ok = !is_err, .text = out.items };
        }
        return error.McpClosed;
    }
};

// Reads one newline-delimited line from a fd. The returned slice is
// owned by `arena` (or page_allocator when null) and survives until the
// next call. Returns null on EOF. `line_buf` holds leftover bytes between
// calls and must be distinct per fd.
fn readLine(fd: posix.fd_t, line_buf: *List, arena: ?Allocator) !?[]const u8 {
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
        if (line_buf.items.len > MAX_LINE) return error.LineTooLong;
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

fn writeAllIo(io: std.Io, file: std.Io.File, bytes: []const u8) !void {
    var wbuf: [8192]u8 = undefined;
    var w = std.Io.File.writerStreaming(file, io, &wbuf);
    try w.interface.writeAll(bytes);
    try w.flush();
}

fn appendJsonEscaped(buf: *List, s: []const u8) !void {
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

fn respond(alloc: Allocator, io: std.Io, id: i64, ok: bool, text: []const u8) !void {
    var buf = List.init(alloc);
    try buf.print("{{\"id\":{d},\"ok\":{s},\"{s}\":\"", .{ id, if (ok) "true" else "false", if (ok) "result" else "error" });
    try appendJsonEscaped(&buf, text);
    try buf.appendSlice("\"}\n");
    try writeAllIo(io, std.Io.File.stdout(), buf.items);
}

fn selfCheck(gpa: Allocator, io: std.Io) !void {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var browser = try Browser.spawn(io, gpa);
    defer browser.deinit();

    const res = try browser.call(arena, "markdown", "{\"url\":\"https://example.com\"}");
    if (res.ok and mem.indexOf(u8, res.text, "Example Domain") != null) {
        std.debug.print("PASS: lightpanda mcp round-trip works\n", .{});
    } else {
        std.debug.print("FAIL: {s}\n", .{res.text});
        std.process.exit(1);
    }
}

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;

    const argv = init.minimal.args.vector; // []const [*:0]const u8 on posix
    if (argv.len > 1 and mem.eql(u8, std.mem.sliceTo(argv[1], 0), "--self-check")) {
        try selfCheck(gpa, io);
        return;
    }

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

        const line = readLine(posix.STDIN_FILENO, &stdin_buf, arena) catch |err| {
            std.debug.print("pi-browser: {s}\n", .{@errorName(err)});
            break;
        } orelse break;
        if (line.len == 0) continue;

        const req = json.parseFromSlice(Request, arena, line, .{ .ignore_unknown_fields = true }) catch |err| {
            respond(arena, io, 0, false, @errorName(err)) catch {};
            continue;
        };

        const res = browser.call(arena, req.value.tool, req.value.params) catch |err| CallResult{
            .ok = false,
            .text = @errorName(err),
        };
        respond(arena, io, req.value.id, res.ok, res.text) catch {};
    }
}
