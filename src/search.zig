// pi-search: web search via OpenAI's server-side web_search tool.
//
// The pi extension (extensions/search.ts) registers the web_search tool and
// bridges calls here. This backend POSTs to the Codex Responses endpoint
// (chatgpt.com/backend-api/codex/responses) with tools:[{type:"web_search"}]
// and streams the SSE response: the model plans queries, OpenAI's index
// searches, and the model writes a grounded answer with url_citation
// annotations. The backend collects web_search_call sources and message
// content parts, inserts [n] citation markers into the answer, and returns
// the answer plus a numbered source list. Mode "results" stops streaming as
// soon as the message item starts (all searches have completed by then) and
// returns only the sources, skipping the answer-generation wait entirely.
//
// Request line:  {"id":1,"op":"search","query":"...","mode":"answer","num_results":8,"recency":"week","domains":["example.com","-bad.com"],"endpoint":"https://chatgpt.com/backend-api/codex/responses","api_key":"...","headers":"[[\"h\",\"v\"],...]","model":"gpt-5.6-terra","timeout_ms":60000}
// Response line: {"id":1,"ok":true,"result":"..."} | {"id":1,"ok":false,"error":"..."}
//
// The HTTP call runs on a worker thread so a hung endpoint cannot stall the
// backend: the main thread enforces the deadline and, on expiry, shuts down
// the worker's socket to unblock it and lets the worker finish on its own.
// Retryable failures (429, 5xx, network errors) are retried once after a
// short backoff. The glue kills the backend on user abort (Esc), so no
// request can outlive its turn.

const std = @import("std");
const posix = std.posix;
const mem = std.mem;
const json = std.json;
const Allocator = std.mem.Allocator;
const common = @import("common.zig");
const List = common.List;
const readLine = common.readLine;
const respond = common.respond;

const MAX_LINE = 4 * 1024 * 1024; // hard cap on a single request line
const MAX_EVENT_LINE = 4 * 1024 * 1024; // cap on a single SSE data line
const MAX_ANSWER = 32 * 1024; // cap on the answer part of the result
const MAX_SNIPPET = 400; // cap on one source snippet
const MAX_SOURCES = 30; // cap on the source list
const DEFAULT_TIMEOUT_MS = 60000;
const RETRY_BACKOFF_MS = 500;

const Request = struct {
    id: i64,
    op: []const u8,
    query: ?[]const u8 = null,
    mode: ?[]const u8 = null,
    num_results: ?u32 = null,
    recency: ?[]const u8 = null,
    domains: ?[]const []const u8 = null,
    endpoint: ?[]const u8 = null,
    api_key: ?[]const u8 = null,
    headers: ?[]const u8 = null,
    model: ?[]const u8 = null,
    timeout_ms: ?u32 = null,
};

const Outcome = struct {
    ok: bool,
    err: []const u8 = "",
    text: []const u8 = "",
};

fn okOutcome(text: []const u8) Outcome {
    return .{ .ok = true, .text = text };
}

fn failOutcome(arena: Allocator, comptime fmt: []const u8, args: anytype) !Outcome {
    return .{ .ok = false, .err = try std.fmt.allocPrint(arena, fmt, args) };
}

// ---------------------------------------------------------------------------
// Collected stream data

const Source = struct {
    title: []const u8 = "",
    url: []const u8 = "",
    snippet: []const u8 = "",
};

const Citation = struct {
    part: usize,
    url: []const u8 = "",
    title: []const u8 = "",
    start: usize = 0,
    end: usize = 0,
    snippet: []const u8 = "", // the cited span text, used as the snippet
};

const Collected = struct {
    sources: std.ArrayList(Source) = .empty,
    parts: std.ArrayList([]const u8) = .empty,
    citations: std.ArrayList(Citation) = .empty,
};

// Normalize a snippet/title for display: collapse whitespace, cap length.
fn normalizeText(arena: Allocator, s: []const u8, cap: usize) ![]const u8 {
    var out = List.init(arena);
    var last_space = true;
    for (s) |c| {
        if (c == '\n' or c == '\r' or c == '\t') {
            if (!last_space and out.items.len > 0) {
                try out.append(' ');
                last_space = true;
            }
            continue;
        }
        try out.append(c);
        last_space = false;
        if (out.items.len >= cap) break;
    }
    return mem.trim(u8, out.items, " ");
}

fn addSource(arena: Allocator, collected: *Collected, url: []const u8, title: []const u8, snippet: []const u8) !void {
    const u = mem.trim(u8, url, " \t\r\n");
    if (u.len == 0) return;
    for (collected.sources.items) |s| {
        if (mem.eql(u8, s.url, u)) return; // dedupe by url
    }
    if (collected.sources.items.len >= MAX_SOURCES) return;
    try collected.sources.append(arena, .{
        .title = try normalizeText(arena, title, 200),
        .url = u,
        .snippet = try normalizeText(arena, snippet, MAX_SNIPPET),
    });
}

// Extract source objects from any of the shapes the web_search_call item
// exposes: item.output, item.action.sources, item.sources, item.results.
fn addSourcesFromValue(arena: Allocator, collected: *Collected, v: json.Value) !void {
    switch (v) {
        .object => |obj| {
            var url: []const u8 = "";
            var title: []const u8 = "";
            var snippet: []const u8 = "";
            if (obj.get("url")) |u| {
                if (u == .string) url = u.string;
            }
            if (url.len == 0) {
                if (obj.get("source_website_url")) |u| {
                    if (u == .string) url = u.string;
                }
            }
            if (url.len == 0) return;
            if (obj.get("title")) |t| {
                if (t == .string) title = t.string;
            }
            if (title.len == 0) {
                if (obj.get("caption")) |t| {
                    if (t == .string) title = t.string;
                }
            }
            if (obj.get("snippet")) |s| {
                if (s == .string) snippet = s.string;
            }
            try addSource(arena, collected, url, title, snippet);
        },
        .array => |items| {
            for (items.items) |item| try addSourcesFromValue(arena, collected, item);
        },
        else => {},
    }
}

fn processWebSearchCall(arena: Allocator, collected: *Collected, item: json.Value) !void {
    const obj = switch (item) {
        .object => |o| o,
        else => return,
    };
    if (obj.get("output")) |out| try addSourcesFromValue(arena, collected, out);
    if (obj.get("action")) |action| {
        if (action == .object) {
            if (action.object.get("sources")) |s| try addSourcesFromValue(arena, collected, s);
        }
    }
    if (obj.get("sources")) |s| try addSourcesFromValue(arena, collected, s);
    if (obj.get("results")) |s| try addSourcesFromValue(arena, collected, s);
}

fn processMessage(arena: Allocator, collected: *Collected, item: json.Value) !void {
    const obj = switch (item) {
        .object => |o| o,
        else => return,
    };
    const content = obj.get("content") orelse return;
    const parts = switch (content) {
        .array => |a| a.items,
        else => return,
    };
    for (parts) |part| {
        if (part != .object) continue;
        const text = if (part.object.get("text")) |t| switch (t) {
            .string => |s| s,
            else => "",
        } else "";
        if (text.len == 0) continue;
        const part_idx = collected.parts.items.len;
        try collected.parts.append(arena, text);
        const annotations = part.object.get("annotations") orelse continue;
        const anns = switch (annotations) {
            .array => |a| a.items,
            else => continue,
        };
        for (anns) |ann| {
            if (ann != .object) continue;
            const ann_type = if (ann.object.get("type")) |t| switch (t) {
                .string => |s| s,
                else => "",
            } else "";
            if (!mem.eql(u8, ann_type, "url_citation")) continue;
            const url = if (ann.object.get("url")) |u| switch (u) {
                .string => |s| s,
                else => "",
            } else "";
            if (url.len == 0) continue;
            const title = if (ann.object.get("title")) |t| switch (t) {
                .string => |s| s,
                else => "",
            } else "";
            const start: usize = if (ann.object.get("start_index")) |v| switch (v) {
                .integer => |i| if (i >= 0 and i <= text.len) @intCast(i) else continue,
                else => continue,
            } else continue;
            const end: usize = if (ann.object.get("end_index")) |v| switch (v) {
                .integer => |i| if (i >= start and i <= text.len) @intCast(i) else continue,
                else => continue,
            } else continue;
            const snippet = if (end > start) text[start..end] else "";
            try collected.citations.append(arena, .{
                .part = part_idx,
                .url = url,
                .title = title,
                .start = start,
                .end = end,
                .snippet = snippet,
            });
        }
    }
}

fn itemType(item: json.Value) []const u8 {
    if (item != .object) return "";
    const t = item.object.get("type") orelse return "";
    if (t != .string) return "";
    return t.string;
}

fn processEvent(arena: Allocator, collected: *Collected, value: json.Value, results_mode: bool, done: *bool) !void {
    const obj = switch (value) {
        .object => |o| o,
        else => return,
    };
    const ev_type = if (obj.get("type")) |t| switch (t) {
        .string => |s| s,
        else => "",
    } else "";
    const item = obj.get("item") orelse return;

    if (mem.eql(u8, ev_type, "response.output_item.done")) {
        const t = itemType(item);
        if (mem.eql(u8, t, "web_search_call")) {
            try processWebSearchCall(arena, collected, item);
        } else if (mem.eql(u8, t, "message")) {
            try processMessage(arena, collected, item);
        }
        return;
    }

    // The message item is added only after every web_search_call completes,
    // so in results mode this is the earliest point where all sources are
    // in and the answer-generation wait can be skipped. If no sources
    // arrived (e.g. sources only in the final response), keep streaming.
    if (results_mode and mem.eql(u8, ev_type, "response.output_item.added")) {
        if (mem.eql(u8, itemType(item), "message") and collected.sources.items.len > 0) {
            done.* = true;
        }
        return;
    }

    if (mem.eql(u8, ev_type, "response.completed") or mem.eql(u8, ev_type, "response.done")) {
        done.* = true;
    }
}

// ---------------------------------------------------------------------------
// Result formatting: answer with [n] citation markers plus a numbered
// source list. Annotation urls missing from the source list are appended as
// sources (their cited span becomes the snippet), so every [n] resolves.

fn findSourceIndex(collected: *Collected, url: []const u8) ?usize {
    for (collected.sources.items, 0..) |s, i| {
        if (mem.eql(u8, s.url, url)) return i;
    }
    return null;
}

fn resolveSourceIndex(arena: Allocator, collected: *Collected, url: []const u8, title: []const u8, snippet: []const u8) !?usize {
    if (findSourceIndex(collected, url)) |i| return i;
    if (collected.sources.items.len >= MAX_SOURCES) return null;
    try addSource(arena, collected, url, title, snippet);
    return findSourceIndex(collected, url);
}

fn formatPart(arena: Allocator, collected: *Collected, part_idx: usize) ![]const u8 {
    const text = collected.parts.items[part_idx];
    var out = List.init(arena);

    // Citations for this part, sorted by start index (stream order usually
    // is, but overlapping or shuffled spans must not break the pass).
    var idxs: std.ArrayList(usize) = .empty;
    for (collected.citations.items, 0..) |c, ci| {
        if (c.part == part_idx and c.end > c.start and c.end <= text.len) try idxs.append(arena, ci);
    }
    std.mem.sort(usize, idxs.items, collected, struct {
        fn lessThan(ctx: *Collected, a: usize, b: usize) bool {
            return ctx.citations.items[a].start < ctx.citations.items[b].start;
        }
    }.lessThan);

    var prev: usize = 0;
    for (idxs.items) |ci| {
        const c = collected.citations.items[ci];
        const src_idx = try resolveSourceIndex(arena, collected, c.url, c.title, c.snippet);
        try out.appendSlice(text[prev..c.start]);
        try out.appendSlice(text[c.start..c.end]);
        if (src_idx) |i| {
            try out.print("[{d}]", .{i + 1});
        }
        prev = c.end;
    }
    try out.appendSlice(text[prev..]);
    return out.items;
}

fn formatResult(arena: Allocator, collected: *Collected, results_mode: bool) ![]const u8 {
    var out = List.init(arena);
    var wrote_answer = false;

    if (!results_mode) {
        for (collected.parts.items, 0..) |_, pi| {
            const part = try formatPart(arena, collected, pi);
            if (part.len == 0) continue;
            if (wrote_answer) try out.appendSlice("\n\n");
            try out.appendSlice(part);
            if (out.items.len >= MAX_ANSWER) break;
            wrote_answer = true;
        }
    }

    if (collected.sources.items.len > 0) {
        if (wrote_answer) try out.appendSlice("\n\n");
        try out.appendSlice("Sources:\n");
        for (collected.sources.items, 0..) |s, i| {
            const title = if (s.title.len > 0) s.title else s.url;
            try out.print("{d}. {s} ({s})\n", .{ i + 1, title, s.url });
            if (s.snippet.len > 0) {
                try out.appendSlice("   ");
                try out.appendSlice(s.snippet);
                try out.appendSlice("\n");
            }
        }
    }
    return out.items;
}

// ---------------------------------------------------------------------------
// Request body

fn buildInstructions(arena: Allocator, num_results: u32, recency: ?[]const u8, domains: ?[]const []const u8) ![]const u8 {
    var ins = List.init(arena);
    try ins.appendSlice("Search the web and return a concise answer grounded only in the web results. Include clickable source citations in the response text when possible.");
    if (recency) |r| {
        const label: ?[]const u8 = if (mem.eql(u8, r, "day"))
            "past 24 hours"
        else if (mem.eql(u8, r, "week"))
            "past week"
        else if (mem.eql(u8, r, "month"))
            "past month"
        else if (mem.eql(u8, r, "year"))
            "past year"
        else
            null;
        if (label) |l| try ins.print(" Prefer sources from the {s}.", .{l});
    }
    if (num_results > 0) {
        try ins.print(" Prefer around {d} distinct sources.", .{num_results});
    }
    if (domains) |ds| {
        var allowed = List.init(arena);
        var blocked = List.init(arena);
        for (ds) |raw| {
            const d = mem.trim(u8, raw, " \t\r\n");
            if (d.len == 0) continue;
            if (d[0] == '-') {
                const rest = mem.trim(u8, d[1..], " \t\r\n");
                if (rest.len > 0) {
                    if (blocked.items.len > 0) try blocked.appendSlice(", ");
                    try blocked.appendSlice(rest);
                }
            } else {
                if (allowed.items.len > 0) try allowed.appendSlice(", ");
                try allowed.appendSlice(d);
            }
        }
        if (allowed.items.len > 0) {
            try ins.appendSlice(" Only use sources from: ");
            try ins.appendSlice(allowed.items);
            try ins.appendSlice(".");
        }
        if (blocked.items.len > 0) {
            try ins.appendSlice(" Do not use sources from: ");
            try ins.appendSlice(blocked.items);
            try ins.appendSlice(".");
        }
    }
    return ins.items;
}

// Appends a JSON string array of the domains that match `blocked`: pass
// false for the allowed list (domains without the "-" prefix), true for the
// blocked list (domains with it, prefix stripped).
fn appendJsonStringArray(buf: *List, domains: []const []const u8, blocked: bool) !void {
    var first = true;
    for (domains) |raw| {
        const d = mem.trim(u8, raw, " \t\r\n");
        if (d.len == 0) continue;
        const is_blocked = d[0] == '-';
        if (blocked != is_blocked) continue;
        const v = if (is_blocked) mem.trim(u8, d[1..], " \t\r\n") else d;
        if (v.len == 0) continue;
        if (!first) try buf.appendSlice(",");
        first = false;
        try buf.append('"');
        try common.appendJsonEscaped(buf, v);
        try buf.append('"');
    }
}

fn buildBody(arena: Allocator, req: Request) ![]const u8 {
    const query = mem.trim(u8, req.query orelse "", " \t\r\n");
    const model = mem.trim(u8, req.model orelse "", " \t\r\n");
    const num_results = @min(req.num_results orelse 8, 20);
    const instructions = try buildInstructions(arena, num_results, req.recency, req.domains);

    var body = List.init(arena);
    try body.appendSlice("{\"model\":\"");
    try common.appendJsonEscaped(&body, model);
    try body.appendSlice("\",\"instructions\":\"");
    try common.appendJsonEscaped(&body, instructions);
    try body.appendSlice("\",\"input\":[{\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"");
    try common.appendJsonEscaped(&body, query);
    try body.appendSlice("\"}]}],\"tools\":[{\"type\":\"web_search\"");

    if (req.domains) |ds| {
        var allowed = List.init(arena);
        try appendJsonStringArray(&allowed, ds, false);
        var blocked = List.init(arena);
        try appendJsonStringArray(&blocked, ds, true);
        if (allowed.items.len > 0 or blocked.items.len > 0) {
            try body.appendSlice(",\"filters\":{");
            if (allowed.items.len > 0) {
                try body.appendSlice("\"allowed_domains\":[");
                try body.appendSlice(allowed.items);
                try body.appendSlice("]");
            }
            if (blocked.items.len > 0) {
                if (allowed.items.len > 0) try body.appendSlice(",");
                try body.appendSlice("\"blocked_domains\":[");
                try body.appendSlice(blocked.items);
                try body.appendSlice("]");
            }
            try body.appendSlice("}");
        }
    }

    try body.appendSlice("}],\"include\":[\"web_search_call.action.sources\"],\"store\":false,\"stream\":true,\"tool_choice\":\"required\",\"parallel_tool_calls\":true}");
    return body.items;
}

// ---------------------------------------------------------------------------
// HTTP call with deadline (worker thread + socket shutdown, same pattern as
// pi-vision). The worker streams the SSE response, collects items, formats
// the result, and signals done. The worker-slot machinery itself
// (WorkerSlot, workerFinish, retryability, httpWithDeadline) lives in
// common.zig, shared with pi-vision.

const WorkerCtx = struct {
    gpa: Allocator,
    io: std.Io,
    url: []const u8,
    api_key: []const u8,
    headers: []const [2][]const u8,
    body: []const u8,
    results_mode: bool,
};

const FetchResult = struct {
    ok: bool,
    retryable: bool,
    text: []const u8,
};

// Stream the SSE response, collecting web_search_call sources and message
// content parts. In results mode the read loop stops as soon as the message
// item is added (all searches have completed by then); in answer mode it
// runs until response.completed or EOF.
fn runSearchFetch(arena: Allocator, io: std.Io, url: []const u8, api_key: []const u8, headers: []const [2][]const u8, body: []const u8, results_mode: bool, slot: *common.WorkerSlot) !FetchResult {
    var client = std.http.Client{ .allocator = arena, .io = io };
    defer client.deinit();
    const uri = try std.Uri.parse(url);

    var hdrs: std.ArrayList(std.http.Header) = .empty;
    try hdrs.append(arena, .{ .name = "content-type", .value = "application/json" });
    var has_auth = false;
    for (headers) |pair| {
        if (std.ascii.eqlIgnoreCase(pair[0], "authorization")) has_auth = true;
        try hdrs.append(arena, .{ .name = pair[0], .value = pair[1] });
    }
    if (!has_auth and api_key.len > 0) {
        try hdrs.append(arena, .{ .name = "authorization", .value = try std.fmt.allocPrint(arena, "Bearer {s}", .{api_key}) });
    }

    var req = try client.request(.POST, uri, .{ .extra_headers = hdrs.items, .redirect_behavior = .unhandled, .keep_alive = false });
    defer req.deinit();
    // Expose the socket fd so the main thread can unblock us on deadline.
    slot.fd.store(req.connection.?.stream_reader.stream.socket.handle, .monotonic);
    req.transfer_encoding = .{ .content_length = body.len };
    var bw = try req.sendBodyUnflushed(&.{});
    try bw.writer.writeAll(body);
    try bw.end();
    try req.connection.?.flush();

    var resp = try req.receiveHead(&.{});
    const code: u16 = @intFromEnum(resp.head.status);
    if (code < 200 or code >= 300) {
        var err_buf: [8192]u8 = undefined;
        var out = std.Io.Writer.fixed(&err_buf);
        var transfer_buf: [64]u8 = undefined;
        var decompress_buf: [std.compress.flate.max_window_len]u8 = undefined;
        var decompress: std.http.Decompress = undefined;
        const reader = resp.readerDecompressing(&transfer_buf, &decompress, &decompress_buf);
        _ = reader.streamRemaining(&out) catch {};
        const err_text = err_buf[0..out.end];
        var message: []const u8 = "";
        if (json.parseFromSliceLeaky(json.Value, arena, err_text, .{}) catch null) |err_value| {
            if (err_value == .object) {
                if (err_value.object.get("error")) |e| {
                    if (e == .object) {
                        if (e.object.get("message")) |m| {
                            if (m == .string and m.string.len > 0) message = m.string;
                        }
                    }
                }
            }
        }
        const text = if (message.len > 0)
            try std.fmt.allocPrint(arena, "search API error {d}: {s}", .{ code, message })
        else
            try std.fmt.allocPrint(arena, "search API error {d}", .{code});
        return .{ .ok = false, .retryable = common.isRetryableStatus(code), .text = text };
    }

    // The client advertises gzip/deflate in Accept-Encoding, so the body must
    // be decompressed; the raw reader would hand back compressed bytes.
    var transfer_buf: [64]u8 = undefined;
    var decompress_buf: [std.compress.flate.max_window_len]u8 = undefined;
    var decompress: std.http.Decompress = undefined;
    const reader = resp.readerDecompressing(&transfer_buf, &decompress, &decompress_buf);

    var collected = Collected{};
    var line_buf: std.ArrayList(u8) = .empty;
    var chunk: [64 * 1024]u8 = undefined;
    var slices: [1][]u8 = .{&chunk};
    var done = false;
    while (!done) {
        // The socket reader buffers internally: bytes that arrived with the
        // response head (or overflow from a read) sit in buffered() and a
        // readVec that filled them returns 0. Drain buffered() first, and
        // after a 0-return read re-check it, or the read loop blocks on a
        // quiet socket while events already received wait in the buffer.
        const buffered = reader.buffered();
        if (buffered.len > 0) {
            try line_buf.appendSlice(arena, buffered);
            reader.toss(buffered.len);
        } else {
            const n = reader.readVec(&slices) catch |err| switch (err) {
                error.EndOfStream => break,
                else => return .{ .ok = false, .retryable = common.isRetryableErr(err), .text = try std.fmt.allocPrint(arena, "search stream read failed: {s}", .{@errorName(err)}) },
            };
            if (n > 0) try line_buf.appendSlice(arena, chunk[0..n]);
        }
        while (mem.indexOfScalar(u8, line_buf.items, '\n')) |nl| {
            const line = mem.trimEnd(u8, line_buf.items[0..nl], "\r");
            if (mem.startsWith(u8, line, "data:")) {
                const payload = mem.trim(u8, line[5..], " \t");
                if (payload.len > 0 and !mem.eql(u8, payload, "[DONE]")) {
                    if (json.parseFromSliceLeaky(json.Value, arena, payload, .{}) catch null) |value| {
                        try processEvent(arena, &collected, value, results_mode, &done);
                    }
                }
            }
            const rest = line_buf.items.len - nl - 1;
            mem.copyForwards(u8, line_buf.items[0..rest], line_buf.items[nl + 1 ..]);
            line_buf.shrinkRetainingCapacity(rest);
        }
        if (line_buf.items.len > MAX_EVENT_LINE) {
            return .{ .ok = false, .retryable = false, .text = "search stream event too large" };
        }
    }

    if (collected.sources.items.len == 0 and collected.parts.items.len == 0) {
        return .{ .ok = false, .retryable = false, .text = "search returned no answer or sources" };
    }
    const formatted = try formatResult(arena, &collected, results_mode);
    if (formatted.len == 0) {
        return .{ .ok = false, .retryable = false, .text = "search returned no answer or sources" };
    }
    return .{ .ok = true, .retryable = false, .text = formatted };
}

fn searchWorker(ctx: *WorkerCtx, slot: *common.WorkerSlot) void {
    var arena_state = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    // Dupe the inputs: the caller's request arena is reset on the next loop
    // iteration while a timed-out worker may still be running.
    const url = arena.dupe(u8, ctx.url) catch return common.workerFinish(slot, false, false, "out of memory");
    const api_key = arena.dupe(u8, ctx.api_key) catch return common.workerFinish(slot, false, false, "out of memory");
    const body = arena.dupe(u8, ctx.body) catch return common.workerFinish(slot, false, false, "out of memory");
    const headers = arena.alloc([2][]const u8, ctx.headers.len) catch return common.workerFinish(slot, false, false, "out of memory");
    for (ctx.headers, 0..) |pair, i| {
        headers[i][0] = arena.dupe(u8, pair[0]) catch return common.workerFinish(slot, false, false, "out of memory");
        headers[i][1] = arena.dupe(u8, pair[1]) catch return common.workerFinish(slot, false, false, "out of memory");
    }

    const res = runSearchFetch(arena, ctx.io, url, api_key, headers, body, ctx.results_mode, slot) catch |err| {
        common.workerFinish(slot, false, common.isRetryableErr(err), @errorName(err));
        return;
    };
    common.workerFinish(slot, res.ok, res.retryable, res.text);
}

// ---------------------------------------------------------------------------
// search op

fn opSearch(gpa: Allocator, arena: Allocator, io: std.Io, req: Request) !Outcome {
    const query = mem.trim(u8, req.query orelse "", " \t\r\n");
    if (query.len == 0) return failOutcome(arena, "missing query", .{});
    const model = mem.trim(u8, req.model orelse "", " \t\r\n");
    if (model.len == 0) return failOutcome(arena, "missing model", .{});
    const endpoint = mem.trim(u8, req.endpoint orelse "", " \t\r\n");
    if (endpoint.len == 0) return failOutcome(arena, "missing endpoint", .{});

    const mode = req.mode orelse "answer";
    const results_mode = mem.eql(u8, mode, "results");
    if (!results_mode and !mem.eql(u8, mode, "answer")) {
        return failOutcome(arena, "mode must be answer or results", .{});
    }

    const body = try buildBody(arena, req);
    const hdrs = common.parseHeaders(arena, req.headers) catch return failOutcome(arena, "invalid headers json", .{});
    const timeout_ms = req.timeout_ms orelse DEFAULT_TIMEOUT_MS;
    const api_key = req.api_key orelse "";

    var attempt: usize = 0;
    while (true) {
        const ctx = WorkerCtx{ .gpa = gpa, .io = io, .url = endpoint, .api_key = api_key, .headers = hdrs, .body = body, .results_mode = results_mode };
        const res = common.httpWithDeadline(gpa, arena, io, ctx, searchWorker, timeout_ms) catch |err| switch (err) {
            error.TimedOut => return failOutcome(arena, "search timed out after {d}ms", .{timeout_ms}),
            else => return failOutcome(arena, "search request failed: {s}", .{@errorName(err)}),
        };
        if (res.ok) return okOutcome(res.text);
        if (!res.retryable or attempt == 1) return failOutcome(arena, "{s}", .{res.err});
        attempt += 1;
        std.Io.sleep(io, std.Io.Duration.fromMilliseconds(RETRY_BACKOFF_MS), .awake) catch {};
    }
}

// ---------------------------------------------------------------------------
// Self-check: exercises the full pipeline against an in-process HTTP server
// (no network, no external API). The server serves scripted SSE streams and
// injects a 500 (retry), a 400 (no retry), and a delayed completion
// (results-mode early stop) plus a slow response (deadline).

const SSE_EVENT_SEARCH = "event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"web_search_call\",\"id\":\"ws_1\",\"action\":{\"type\":\"search\",\"sources\":[{\"url\":\"https://example.com/alpha\",\"title\":\"Alpha Example\"}]},\"output\":[{\"url\":\"https://example.com/alpha\",\"title\":\"Alpha Example\",\"snippet\":\"Alpha results here\"}]}}\n\n";
const SSE_EVENT_MESSAGE = "event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"message\",\"id\":\"msg_1\",\"content\":[{\"type\":\"output_text\",\"text\":\"The answer is alpha.\",\"annotations\":[{\"type\":\"url_citation\",\"url\":\"https://example.com/alpha\",\"title\":\"Alpha Example\",\"start_index\":14,\"end_index\":19}]}]}}\n\n";
const SSE_EVENT_MESSAGE_TWO = "event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"message\",\"id\":\"msg_1\",\"content\":[{\"type\":\"output_text\",\"text\":\"Alpha and beta both matter.\",\"annotations\":[{\"type\":\"url_citation\",\"url\":\"https://example.com/alpha\",\"title\":\"Alpha Example\",\"start_index\":0,\"end_index\":5},{\"type\":\"url_citation\",\"url\":\"https://example.com/beta\",\"title\":\"Beta Example\",\"start_index\":10,\"end_index\":14}]}]}}\n\n";
const SSE_EVENT_MESSAGE_ADDED = "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"message\",\"id\":\"msg_1\",\"status\":\"in_progress\",\"content\":[]}}\n\n";
const SSE_EVENT_COMPLETED = "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\",\"output\":[]}}\n\n";
const SSE_STREAM_FULL = SSE_EVENT_SEARCH ++ SSE_EVENT_MESSAGE ++ SSE_EVENT_COMPLETED;

const SELFCHECK_REQUESTS = 7;

const SelfCheckCtx = struct {
    gpa: Allocator,
    io: std.Io,
    port: std.atomic.Value(u16) = std.atomic.Value(u16).init(0),
    bodies: [SELFCHECK_REQUESTS][64 * 1024]u8 = undefined,
    body_lens: [SELFCHECK_REQUESTS]usize = [_]usize{0} ** SELFCHECK_REQUESTS,
    served: std.atomic.Value(usize) = std.atomic.Value(usize).init(0),
};

fn serveThread(ctx: *SelfCheckCtx) void {
    const io = ctx.io;
    var server = std.Io.net.IpAddress.listen(&.{ .ip4 = std.Io.net.Ip4Address.loopback(0) }, io, .{ .mode = .stream }) catch return;
    defer server.deinit(io);
    const port = switch (server.socket.address) {
        .ip4 => |a| a.port,
        else => return,
    };
    ctx.port.store(port, .release);

    var idx: usize = 0;
    while (idx < SELFCHECK_REQUESTS) : (idx += 1) {
        const stream = server.accept(io) catch continue;
        defer stream.close(io);
        var rbuf: [16 * 1024]u8 = undefined;
        var wbuf: [8192]u8 = undefined;
        var sr = stream.reader(io, &rbuf);
        var sw = stream.writer(io, &wbuf);
        var hs = std.http.Server.init(&sr.interface, &sw.interface);
        var req = hs.receiveHead() catch continue;
        if (!mem.eql(u8, req.head.target, "/responses")) continue;

        var transfer: [8192]u8 = undefined;
        var body_storage: [64 * 1024]u8 = undefined;
        const br = req.readerExpectNone(&transfer);
        var bw = std.Io.Writer.fixed(&body_storage);
        _ = br.streamRemaining(&bw) catch continue;
        const blen = bw.end;
        @memcpy(ctx.bodies[idx][0..blen], body_storage[0..blen]);
        ctx.body_lens[idx] = blen;

        switch (idx) {
            0 => req.respond(SSE_STREAM_FULL, .{ .extra_headers = &.{.{ .name = "content-type", .value = "text/event-stream" }} }) catch {},
            1 => req.respond("{\"error\":{\"message\":\"self-check injected 500\",\"type\":\"server_error\"}}", .{ .status = .internal_server_error }) catch {},
            2 => req.respond(SSE_STREAM_FULL, .{ .extra_headers = &.{.{ .name = "content-type", .value = "text/event-stream" }} }) catch {},
            3 => req.respond("{\"error\":{\"message\":\"self-check injected 400\",\"type\":\"invalid_request_error\"}}", .{ .status = .bad_request }) catch {},
            4 => {
                // Results-mode early stop: the message item is added right
                // after the search call completes, then the server stalls
                // 1.5s before response.completed. A client that keeps
                // streaming hits the 600ms deadline; one that stops early
                // (the whole point of results mode) returns immediately.
                sw.interface.writeAll("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n") catch {};
                sw.interface.flush() catch {};
                sw.interface.writeAll(SSE_EVENT_SEARCH) catch {};
                sw.interface.flush() catch {};
                sw.interface.writeAll(SSE_EVENT_MESSAGE_ADDED) catch {};
                sw.interface.flush() catch {};
                std.Io.sleep(io, std.Io.Duration.fromMilliseconds(1500), .awake) catch {};
                sw.interface.writeAll(SSE_EVENT_COMPLETED) catch {};
                sw.interface.flush() catch {};
            },
            5 => req.respond(SSE_EVENT_SEARCH ++ SSE_EVENT_MESSAGE_TWO ++ SSE_EVENT_COMPLETED, .{ .extra_headers = &.{.{ .name = "content-type", .value = "text/event-stream" }} }) catch {},
            else => {
                std.Io.sleep(io, std.Io.Duration.fromMilliseconds(2000), .awake) catch {};
                req.respond(SSE_STREAM_FULL, .{ .extra_headers = &.{.{ .name = "content-type", .value = "text/event-stream" }} }) catch {};
            },
        }
        ctx.served.store(idx + 1, .release);
    }
}

const SELFCHECK_HEADERS = "[[\"authorization\",\"Bearer selfcheck-key\"],[\"chatgpt-account-id\",\"acct_selfcheck\"],[\"originator\",\"pi\"],[\"openai-beta\",\"responses=experimental\"]]";

fn selfCheck(gpa: Allocator, io: std.Io) !void {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const fail = common.expect;

    const sctx = try gpa.create(SelfCheckCtx);
    sctx.* = .{ .gpa = gpa, .io = io };
    defer gpa.destroy(sctx);
    const server_thread = std.Thread.spawn(.{}, serveThread, .{sctx}) catch return error.ThreadSpawnFailed;
    defer server_thread.join();

    while (sctx.port.load(.acquire) == 0) {
        std.Io.sleep(io, std.Io.Duration.fromMilliseconds(10), .awake) catch {};
    }
    const endpoint = try std.fmt.allocPrint(arena, "http://127.0.0.1:{d}/responses", .{sctx.port.load(.acquire)});

    const mkreq = struct {
        fn f(ep: []const u8, query: []const u8, mode: []const u8, num_results: u32, recency: ?[]const u8, domains: ?[]const []const u8, timeout_ms: u32) Request {
            return .{ .id = 1, .op = "search", .query = query, .mode = mode, .num_results = num_results, .recency = recency, .domains = domains, .endpoint = ep, .api_key = "selfcheck-key", .headers = SELFCHECK_HEADERS, .model = "gpt-5.6-terra", .timeout_ms = timeout_ms };
        }
    }.f;

    // 1. answer mode happy path: cited answer, [1] marker, source list with
    //    snippet. The body carries recency/domain filters and instructions.
    const r1 = try opSearch(gpa, arena, io, mkreq(endpoint, "alpha docs", "answer", 8, "week", &.{ "example.com", "-bad.com" }, 10000));
    fail(r1.ok, "answer mode succeeds");
    fail(mem.indexOf(u8, r1.text, "The answer is alpha[1].") != null, "citation marker [1] is inserted after the cited span");
    fail(mem.indexOf(u8, r1.text, "1. Alpha Example (https://example.com/alpha)") != null, "source list has the numbered entry");
    fail(mem.indexOf(u8, r1.text, "Alpha results here") != null, "source snippet is included");
    const b1 = sctx.bodies[0][0..sctx.body_lens[0]];
    fail(mem.indexOf(u8, b1, "\"model\":\"gpt-5.6-terra\"") != null, "body carries the model");
    fail(mem.indexOf(u8, b1, "\"type\":\"web_search\"") != null, "body enables the web_search tool");
    fail(mem.indexOf(u8, b1, "\"tool_choice\":\"required\"") != null, "body forces the tool call");
    fail(mem.indexOf(u8, b1, "web_search_call.action.sources") != null, "body requests the sources include");
    fail(mem.indexOf(u8, b1, "\"allowed_domains\":[\"example.com\"]") != null, "allowed domains become a server filter");
    fail(mem.indexOf(u8, b1, "\"blocked_domains\":[\"bad.com\"]") != null, "blocked domains become a server filter");
    fail(mem.indexOf(u8, b1, "Prefer sources from the past week.") != null, "recency becomes an instruction");
    fail(mem.indexOf(u8, b1, "around 8 distinct sources") != null, "numResults becomes an instruction");

    // 2. retry: the server's injected 500 is retried once and succeeds.
    const r2 = try opSearch(gpa, arena, io, mkreq(endpoint, "retry me", "answer", 5, null, null, 10000));
    fail(r2.ok, "a 500 is retried and succeeds");
    fail(mem.indexOf(u8, r2.text, "The answer is alpha[1].") != null, "retried request returns the answer");

    // 3. a 400 surfaces immediately with the provider's message.
    const r3 = try opSearch(gpa, arena, io, mkreq(endpoint, "fail me", "answer", 5, null, null, 10000));
    fail(!r3.ok and mem.indexOf(u8, r3.err, "self-check injected 400") != null, "4xx surfaces the provider error");

    // 4. results mode stops at the message item: sources only, no answer,
    //    and no timeout despite the stalled completion.
    const r4 = try opSearch(gpa, arena, io, mkreq(endpoint, "quick look", "results", 5, null, null, 600));
    fail(r4.ok, "results mode returns before the stalled completion");
    fail(mem.indexOf(u8, r4.text, "1. Alpha Example (https://example.com/alpha)") != null, "results mode has the source");
    fail(mem.indexOf(u8, r4.text, "The answer is alpha") == null, "results mode skips the answer");
    fail(mem.indexOf(u8, r4.text, "Sources:") != null, "results mode formats the source list");

    // 5. annotation-only citations append sources and dedupe against the
    //    web_search_call list: alpha keeps [1], beta becomes source 2.
    const r5 = try opSearch(gpa, arena, io, mkreq(endpoint, "two cites", "answer", 5, null, null, 10000));
    fail(r5.ok, "multi-citation answer succeeds");
    fail(mem.indexOf(u8, r5.text, "Alpha[1] and beta[2] both matter.") != null, "both markers resolve");
    fail(mem.indexOf(u8, r5.text, "2. Beta Example (https://example.com/beta)") != null, "annotation-only url becomes source 2");
    fail(mem.indexOf(u8, r5.text, "beta") != null and mem.indexOf(u8, r5.text, "1. Alpha Example") != null, "sources dedupe (one alpha entry)");
    fail(mem.indexOf(u8, r5.text, "3.") == null, "no duplicate sources");

    // 6. the deadline fires on a slow endpoint.
    const r6 = opSearch(gpa, arena, io, mkreq(endpoint, "slow", "answer", 5, null, null, 300)) catch |err| {
        fail(err == error.TimedOut, "deadline fires on a slow endpoint");
        return;
    };
    fail(!r6.ok and mem.indexOf(u8, r6.err, "timed out") != null, "deadline reported as a timeout");

    // The server must have served exactly 7 requests (happy, 500, retry,
    // 400, results, two-cites, timeout). Wait for the server to finish (the
    // timeout test's response lands ~2s after the client gave up, and the
    // results test's completion ~1.5s after the client left) before counting.
    var waited: i64 = 0;
    while (sctx.served.load(.acquire) != SELFCHECK_REQUESTS) : (waited += 10) {
        if (waited > 10000) break;
        std.Io.sleep(io, std.Io.Duration.fromMilliseconds(10), .awake) catch {};
    }
    fail(sctx.served.load(.acquire) == SELFCHECK_REQUESTS, "server request count is exact");

    std.debug.print("PASS: pi-search self-check ok\n", .{});
}

// ---------------------------------------------------------------------------
// main

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;

    const argv = init.minimal.args.vector;
    if (argv.len > 1 and mem.eql(u8, std.mem.sliceTo(argv[1], 0), "--self-check")) {
        try selfCheck(gpa, io);
        return;
    }

    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    var stdin_buf = List.init(gpa);
    defer stdin_buf.deinit();

    while (true) {
        _ = arena_state.reset(.retain_capacity);
        const arena = arena_state.allocator();

        const line = readLine(posix.STDIN_FILENO, &stdin_buf, MAX_LINE, arena, null) catch break orelse break;
        if (line.len == 0) continue;

        const req = json.parseFromSlice(Request, arena, line, .{ .ignore_unknown_fields = true }) catch |err| {
            respond(arena, io, 0, false, @errorName(err)) catch {};
            continue;
        };
        const id = req.value.id;

        if (mem.eql(u8, req.value.op, "search")) {
            const outcome = opSearch(gpa, arena, io, req.value) catch |err| {
                respond(arena, io, id, false, @errorName(err)) catch {};
                continue;
            };
            if (outcome.ok) respond(arena, io, id, true, outcome.text) catch {} else respond(arena, io, id, false, outcome.err) catch {};
        } else {
            respond(arena, io, id, false, "unknown op") catch {};
        }
    }
}
