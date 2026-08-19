// pi-browser: headless browser backend for the pi coding agent.
//
// One-shot client for the lightpanda MCP daemon. The glue spawns this
// binary once per tool call with the request as one JSON argv element; we
// POST a single MCP tools/call (JSON-RPC 2.0 over HTTP) to the daemon that
// launchd keeps running, print one JSON envelope to stdout, and exit.
//
// The daemon is a long-lived `lightpanda mcp --port 8931` process started
// by `mise run daemon-start` (docs/daemons.md). Pages live in the daemon:
// the model opens a URL in one call and reads it in the next because every
// call attaches to the same session, sent as the Mcp-Session-Id header.
// The MCP initialize handshake is skipped: lightpanda accepts tools/call
// directly and creates the session on first use (verified against the
// 2026.08 nightly). If a future build starts requiring the handshake, add
// the initialize + notifications/initialized POSTs back.
//
// Request:  {"op":"goto","params":"{\"url\":\"https://...\"}"}   params is a JSON string
// Response: {"ok":true,"result":"..."}  or  {"ok":false,"error":"..."}
// Exit:     0 on ok, 1 on protocol error, other on crash (trace on stderr)
//
// The per-call deadline runs on the shared httpWithDeadline worker (same
// machinery as pi-search/pi-vision): the daemon stays alive on a timeout,
// the in-flight MCP call finishes server-side, and the session proceeds.

const std = @import("std");
const mem = std.mem;
const json = std.json;
const Allocator = std.mem.Allocator;
const common = @import("common.zig");
const List = common.List;
const http = std.http;
const respondExit = common.respondExit;

const DAEMON_HOST = "127.0.0.1"; // keep in sync with scripts/com.pijon.lightpanda.plist
const DAEMON_PORT = 8931;
const SESSION_ID = "pi-main"; // stable client-chosen MCP session (one tab per daemon run)

// Backstop for a single MCP tool call. Lightpanda runs its own (far
// shorter) timeouts for navigation, waits, and evaluate, so this only
// fires when the daemon stalls. On expiry the worker socket is shut down,
// the envelope reports the timeout, and the daemon keeps running.
const CALL_TIMEOUT_MS: u32 = 120_000;

const MAX_BODY = 16 * 1024 * 1024; // cap on a single response body read
// Cap on the extracted text returned to the glue. The shared WorkerSlot
// truncates at 64KiB (common.MAX_RESULT_TEXT), so 60KiB keeps the head/tail
// truncation marker intact under that limit.
const RESULT_CAP = 60 * 1024;

const Request = struct {
    op: []const u8, // MCP tool name, e.g. "goto"
    params: []const u8 = "{}", // JSON string containing the raw arguments object
};

const WorkerCtx = struct {
    gpa: Allocator,
    io: std.Io,
    op: []const u8,
    params: []const u8,
};

// Truncates extracted text over cap to its head and tail with an explicit
// marker, so the model still sees the start and end of the page.
fn capResult(arena: Allocator, text: []const u8, cap: usize) ![]const u8 {
    if (text.len <= cap) return text;
    const head_len = cap * 3 / 4;
    const tail_len = cap - head_len;
    return std.fmt.allocPrint(arena, "{s}\n\n… [{d} bytes truncated] …\n\n{s}", .{ text[0..head_len], text.len - cap, text[text.len - tail_len ..] });
}

fn isDaemonDown(err: anyerror) bool {
    return switch (err) {
        error.ConnectionRefused,
        error.NetworkUnreachable,
        error.HostUnreachable,
        error.ConnectionResetByPeer,
        error.BrokenPipe,
        => true,
        else => false,
    };
}

const McpResult = struct {
    ok: bool,
    text: []const u8,
};

// Extracts the text result from a JSON-RPC response body.
fn parseMcpResponse(arena: Allocator, body: []const u8) !McpResult {
    const parsed = json.parseFromSliceLeaky(json.Value, arena, body, .{ .ignore_unknown_fields = true }) catch {
        return .{ .ok = false, .text = "daemon response is not valid JSON" };
    };
    if (parsed != .object) return .{ .ok = false, .text = "daemon response is not an object" };
    const obj = parsed.object;

    if (obj.get("error")) |err_obj| {
        if (err_obj == .object) {
            if (err_obj.object.get("message")) |m| {
                if (m == .string and m.string.len > 0) return .{ .ok = false, .text = m.string };
            }
        }
        return .{ .ok = false, .text = "MCP error" };
    }

    const result = obj.get("result") orelse return .{ .ok = false, .text = "daemon response missing result" };
    if (result == .string) return .{ .ok = true, .text = try capResult(arena, result.string, RESULT_CAP) };

    if (result == .object) {
        const ro = result.object;
        const is_err = if (ro.get("isError")) |v| (v == .bool and v.bool) else false;
        var out = List.init(arena);
        if (ro.get("content")) |content| {
            if (content == .array) {
                for (content.array.items) |item| {
                    if (item != .object) continue;
                    const item_obj = item.object;
                    const t = item_obj.get("type") orelse continue;
                    if (t != .string or !mem.eql(u8, t.string, "text")) continue;
                    if (item_obj.get("text")) |txt| {
                        if (txt == .string) try out.appendSlice(txt.string);
                    }
                }
            }
        }
        return .{ .ok = !is_err, .text = try capResult(arena, out.items, RESULT_CAP) };
    }

    return .{ .ok = false, .text = "daemon response result has an unexpected shape" };
}

// POSTs one MCP tools/call to the daemon and returns the extracted text.
// `slot` receives the socket fd so the httpWithDeadline path can shut it
// down when the call exceeds CALL_TIMEOUT_MS.
fn callTool(arena: Allocator, io: std.Io, slot: *common.WorkerSlot, op: []const u8, params: []const u8) !McpResult {
    var client = http.Client{ .allocator = arena, .io = io };
    defer client.deinit();
    const uri = try std.Uri.parse(try std.fmt.allocPrint(arena, "http://{s}:{d}/mcp", .{ DAEMON_HOST, DAEMON_PORT }));

    const body = try std.fmt.allocPrint(arena, "{{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{{\"name\":\"{s}\",\"arguments\":{s}}}}}", .{ op, params });

    var hdrs: std.ArrayList(http.Header) = .empty;
    try hdrs.append(arena, .{ .name = "content-type", .value = "application/json" });
    try hdrs.append(arena, .{ .name = "accept", .value = "application/json" });
    try hdrs.append(arena, .{ .name = "mcp-session-id", .value = SESSION_ID });

    var req = try client.request(.POST, uri, .{ .extra_headers = hdrs.items, .redirect_behavior = .unhandled, .keep_alive = false });
    defer req.deinit();
    // Expose the socket fd so the deadline path can unblock us.
    slot.fd.store(req.connection.?.stream_reader.stream.socket.handle, .monotonic);
    req.transfer_encoding = .{ .content_length = body.len };
    var bw = try req.sendBodyUnflushed(&.{});
    try bw.writer.writeAll(body);
    try bw.end();
    try req.connection.?.flush();

    var resp = try req.receiveHead(&.{});
    const code: u16 = @intFromEnum(resp.head.status);
    if (code != 200) {
        var err_buf: [4096]u8 = undefined;
        var out = std.Io.Writer.fixed(&err_buf);
        var transfer_buf: [64]u8 = undefined;
        var decompress_buf: [std.compress.flate.max_window_len]u8 = undefined;
        var decompress: http.Decompress = undefined;
        const reader = resp.readerDecompressing(&transfer_buf, &decompress, &decompress_buf);
        _ = reader.streamRemaining(&out) catch {};
        return .{ .ok = false, .text = try std.fmt.allocPrint(arena, "daemon HTTP {d}: {s}", .{ code, err_buf[0..out.end] }) };
    }

    // The client advertises gzip/deflate in Accept-Encoding, so the body
    // must be decompressed; the raw reader would hand back compressed bytes.
    var transfer_buf: [64]u8 = undefined;
    var decompress_buf: [std.compress.flate.max_window_len]u8 = undefined;
    var decompress: http.Decompress = undefined;
    const reader = resp.readerDecompressing(&transfer_buf, &decompress, &decompress_buf);

    // Read the response body, bounded by MAX_BODY (enough for the head/tail
    // cap). The socket reader buffers internally: bytes that arrived with
    // the response head sit in buffered() and a readVec that filled them
    // returns 0, so drain buffered() first and re-check it after any
    // 0-return read.
    var body_buf: std.ArrayList(u8) = .empty;
    var chunk: [64 * 1024]u8 = undefined;
    var slices: [1][]u8 = .{&chunk};
    blk: while (true) {
        const buffered = reader.buffered();
        if (buffered.len > 0) {
            try body_buf.appendSlice(arena, buffered);
            reader.toss(buffered.len);
        } else {
            const n = reader.readVec(&slices) catch |err| switch (err) {
                error.EndOfStream => break :blk,
                else => return .{ .ok = false, .text = try std.fmt.allocPrint(arena, "daemon response read failed: {s}", .{@errorName(err)}) },
            };
            if (n > 0) try body_buf.appendSlice(arena, chunk[0..n]);
        }
        if (body_buf.items.len > MAX_BODY) break :blk;
    }

    return parseMcpResponse(arena, body_buf.items);
}

fn browserWorker(ctx: *WorkerCtx, slot: *common.WorkerSlot) void {
    var arena_state = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    // Dupe the inputs: the caller's request arena outlives this worker, but
    // the pattern is copy-on-entry like search/vision, so a timed-out worker
    // never reads memory the caller freed.
    const op = arena.dupe(u8, ctx.op) catch return common.workerFinish(slot, false, false, "out of memory");
    const params = arena.dupe(u8, ctx.params) catch return common.workerFinish(slot, false, false, "out of memory");

    const res = callTool(arena, ctx.io, slot, op, params) catch |err| {
        if (isDaemonDown(err)) {
            common.workerFinish(slot, false, false, "lightpanda daemon is not running (start it with `mise run daemon-start`) or unreachable on 127.0.0.1:8931");
            return;
        }
        common.workerFinish(slot, false, false, @errorName(err));
        return;
    };
    common.workerFinish(slot, res.ok, false, res.text);
}

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;

    const argv = init.minimal.args.vector;
    if (argv.len < 2) {
        std.debug.print("usage: pi-browser '<request json>'\n", .{});
        std.process.exit(2);
    }

    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const req = json.parseFromSlice(Request, arena, std.mem.sliceTo(argv[1], 0), .{ .ignore_unknown_fields = true }) catch |err|
        respondExit(arena, io, false, @errorName(err));

    const ctx = WorkerCtx{ .gpa = gpa, .io = io, .op = req.value.op, .params = req.value.params };
    const res = common.httpWithDeadline(gpa, arena, io, ctx, browserWorker, CALL_TIMEOUT_MS) catch |err|
        respondExit(arena, io, false, @errorName(err));

    respondExit(arena, io, res.ok, if (res.ok) res.text else res.err);
}
