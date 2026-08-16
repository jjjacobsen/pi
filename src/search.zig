// pi-search: web search via the Exa API.
//
// The pi extension (extensions/search.ts) registers the web_search tool and
// bridges calls here. This backend POSTs to api.exa.ai/search with the
// user's EXA_API_KEY and formats the raw results as a numbered source list
// with excerpts. Exa has no built-in answer synthesis, so the model writes
// the grounded answer itself and cites sources as [n] against the returned
// list. Mode "answer" requests longer page excerpts (maxCharacters 900) so
// the model can synthesize; mode "results" requests short excerpts (250)
// and returns just the compact list, faster and cheaper.
//
// Request line:  {"id":1,"op":"search","query":"...","mode":"answer","num_results":8,"recency":"week","domains":["example.com","-bad.com"],"api_key":"...","timeout_ms":30000}
// Response line: {"id":1,"ok":true,"result":"...","usage":{"...cost..."}} | {"id":1,"ok":false,"error":"..."}
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
const MAX_BODY = 4 * 1024 * 1024; // cap on the Exa response body
const MAX_ANSWER = 32 * 1024; // cap on the formatted result
const MAX_SNIPPET = 250; // excerpt cap in results mode
const MAX_EXCERPT = 900; // excerpt cap in answer mode
const MAX_SOURCES = 30; // cap on the source list
const MAX_NUM_RESULTS = 10; // Exa's standard per-request cap
const DEFAULT_TIMEOUT_MS = 30000;
const RETRY_BACKOFF_MS = 500;
const EXA_URL = "https://api.exa.ai/search";

const Request = struct {
    id: i64,
    op: []const u8,
    query: ?[]const u8 = null,
    mode: ?[]const u8 = null,
    num_results: ?u32 = null,
    recency: ?[]const u8 = null,
    domains: ?[]const []const u8 = null,
    endpoint: ?[]const u8 = null, // self-check override; defaults to EXA_URL
    api_key: ?[]const u8 = null,
    timeout_ms: ?u32 = null,
};

const Outcome = common.Outcome;
const failOutcome = common.failOutcome;
const respondOutcome = common.respondOutcome;

// ---------------------------------------------------------------------------
// Result formatting

const Source = struct {
    title: []const u8 = "",
    url: []const u8 = "",
    snippet: []const u8 = "",
};

// Normalize an excerpt for display: collapse whitespace, cap length.
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

fn addSource(arena: Allocator, sources: *std.ArrayList(Source), url: []const u8, title: []const u8, snippet: []const u8) !void {
    const u = mem.trim(u8, url, " \t\r\n");
    if (u.len == 0) return;
    for (sources.items) |s| {
        if (mem.eql(u8, s.url, u)) return; // dedupe by url
    }
    if (sources.items.len >= MAX_SOURCES) return;
    try sources.append(arena, .{
        .title = try normalizeText(arena, title, 200),
        .url = u,
        .snippet = snippet,
    });
}

fn formatResult(arena: Allocator, sources: []const Source) ![]const u8 {
    var out = List.init(arena);
    try out.appendSlice("Sources:\n");
    for (sources, 0..) |s, i| {
        if (out.items.len >= MAX_ANSWER) break;
        const title = if (s.title.len > 0) s.title else s.url;
        try out.print("{d}. {s} ({s})\n", .{ i + 1, title, s.url });
        if (s.snippet.len > 0) {
            try out.appendSlice("   ");
            try out.appendSlice(s.snippet);
            try out.appendSlice("\n");
        }
    }
    return out.items;
}

// Exa's costDollars.total (USD) as pi usage JSON, so /usage aggregates
// web_search under the Tools provider. No tokens to report; cost only.
fn usageJson(arena: Allocator, total: f64) ![]const u8 {
    return std.fmt.allocPrint(arena, "{{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0,\"totalTokens\":0,\"reasoning\":0,\"cost\":{{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0,\"total\":{d}}}}}", .{total});
}

// ---------------------------------------------------------------------------
// Request body

const Domain = struct {
    value: []const u8, // trimmed, '-' prefix stripped for blocked domains
    blocked: bool,
};

// One domain filter entry: "example.com" -> allowed, "-bad.com" -> blocked.
// Empty entries and a bare "-" yield null.
fn classifyDomain(raw: []const u8) ?Domain {
    const d = mem.trim(u8, raw, " \t\r\n");
    if (d.len == 0) return null;
    if (d[0] == '-') {
        const rest = mem.trim(u8, d[1..], " \t\r\n");
        if (rest.len == 0) return null;
        return .{ .value = rest, .blocked = true };
    }
    return .{ .value = d, .blocked = false };
}

// Appends a JSON string array of the domains that match `blocked`: pass
// false for the allowed list (domains without the "-" prefix), true for the
// blocked list (domains with it, prefix stripped).
fn appendJsonStringArray(buf: *List, domains: []const []const u8, blocked: bool) !void {
    var first = true;
    for (domains) |raw| {
        const d = classifyDomain(raw) orelse continue;
        if (blocked != d.blocked) continue;
        if (!first) try buf.appendSlice(",");
        first = false;
        try buf.append('"');
        try common.appendJsonEscaped(buf, d.value);
        try buf.append('"');
    }
}

fn recencyDays(r: []const u8) ?u64 {
    if (mem.eql(u8, r, "day")) return 1;
    if (mem.eql(u8, r, "week")) return 7;
    if (mem.eql(u8, r, "month")) return 30;
    if (mem.eql(u8, r, "year")) return 365;
    return null;
}

// ISO 8601 UTC timestamp for `days` ago, Exa's startPublishedDate format.
fn isoDateAgo(arena: Allocator, days: u64) ![]const u8 {
    var ts: posix.timespec = undefined;
    _ = std.c.clock_gettime(std.c.CLOCK.REALTIME, &ts);
    const now: u64 = if (ts.sec >= 0) @intCast(ts.sec) else 0;
    const target = now - days * 86400;
    const es = std.time.epoch.EpochSeconds{ .secs = target };
    const yd = es.getEpochDay().calculateYearDay();
    const md = yd.calculateMonthDay();
    const ds = es.getDaySeconds();
    return std.fmt.allocPrint(arena, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.000Z", .{
        yd.year,
        @intFromEnum(md.month),
        md.day_index + 1,
        ds.getHoursIntoDay(),
        ds.getMinutesIntoHour(),
        ds.getSecondsIntoMinute(),
    });
}

fn buildBody(arena: Allocator, query: []const u8, num_results: u32, recency: ?[]const u8, domains: ?[]const []const u8, excerpt_cap: usize) ![]const u8 {
    var body = List.init(arena);
    try body.appendSlice("{\"query\":\"");
    try common.appendJsonEscaped(&body, query);
    try body.print("\",\"numResults\":{d},\"type\":\"auto\",\"useAutoprompt\":false", .{num_results});

    if (domains) |ds| {
        var allowed = List.init(arena);
        try appendJsonStringArray(&allowed, ds, false);
        var blocked = List.init(arena);
        try appendJsonStringArray(&blocked, ds, true);
        if (allowed.items.len > 0) {
            try body.appendSlice(",\"includeDomains\":[");
            try body.appendSlice(allowed.items);
            try body.appendSlice("]");
        }
        if (blocked.items.len > 0) {
            try body.appendSlice(",\"excludeDomains\":[");
            try body.appendSlice(blocked.items);
            try body.appendSlice("]");
        }
    }

    if (recency) |r| {
        if (recencyDays(r)) |days| {
            const start = try isoDateAgo(arena, days);
            try body.appendSlice(",\"startPublishedDate\":\"");
            try body.appendSlice(start);
            try body.appendSlice("\"");
        }
    }

    try body.print(",\"contents\":{{\"text\":{{\"maxCharacters\":{d}}}}}}}", .{excerpt_cap});
    return body.items;
}

// ---------------------------------------------------------------------------
// HTTP call with deadline (worker thread + socket shutdown, same pattern as
// pi-vision). The worker posts the search, parses the JSON response, formats
// the result, and signals done. The worker-slot machinery itself
// (WorkerSlot, workerFinish, retryability, httpWithDeadline) lives in
// common.zig, shared with pi-vision.

const WorkerCtx = struct {
    gpa: Allocator,
    io: std.Io,
    url: []const u8,
    api_key: []const u8,
    body: []const u8,
    excerpt_cap: usize,
};

const FetchResult = struct {
    ok: bool,
    retryable: bool,
    text: []const u8,
    usage: ?[]const u8 = null,
};

// Extracts the provider's message from a non-2xx body: Exa uses "error"
// (plain string) and sometimes "message".
fn exaErrorText(arena: Allocator, code: u16, err_text: []const u8) ![]const u8 {
    var message: []const u8 = "";
    if (json.parseFromSliceLeaky(json.Value, arena, err_text, .{}) catch null) |err_value| {
        if (err_value == .object) {
            if (err_value.object.get("error")) |e| {
                if (e == .string and e.string.len > 0) message = e.string;
            }
            if (message.len == 0) {
                if (err_value.object.get("message")) |m| {
                    if (m == .string and m.string.len > 0) message = m.string;
                }
            }
        }
    }
    if (message.len > 0) {
        return std.fmt.allocPrint(arena, "Exa API error {d}: {s}", .{ code, message });
    }
    return std.fmt.allocPrint(arena, "Exa API error {d}", .{code});
}

fn runExaFetch(arena: Allocator, io: std.Io, url: []const u8, api_key: []const u8, body: []const u8, excerpt_cap: usize, slot: *common.WorkerSlot) !FetchResult {
    var client = std.http.Client{ .allocator = arena, .io = io };
    defer client.deinit();
    const uri = try std.Uri.parse(url);

    var hdrs: std.ArrayList(std.http.Header) = .empty;
    try hdrs.append(arena, .{ .name = "content-type", .value = "application/json" });
    try hdrs.append(arena, .{ .name = "x-api-key", .value = api_key });

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
        return .{ .ok = false, .retryable = common.isRetryableStatus(code), .text = try exaErrorText(arena, code, err_buf[0..out.end]) };
    }

    // The client advertises gzip/deflate in Accept-Encoding, so the body must
    // be decompressed; the raw reader would hand back compressed bytes.
    var transfer_buf: [64]u8 = undefined;
    var decompress_buf: [std.compress.flate.max_window_len]u8 = undefined;
    var decompress: std.http.Decompress = undefined;
    const reader = resp.readerDecompressing(&transfer_buf, &decompress, &decompress_buf);

    // Read the full response body. The socket reader buffers internally:
    // bytes that arrived with the response head sit in buffered() and a
    // readVec that filled them returns 0, so drain buffered() first and
    // re-check it after any 0-return read.
    var body_buf: std.ArrayList(u8) = .empty;
    var chunk: [64 * 1024]u8 = undefined;
    var slices: [1][]u8 = .{&chunk};
    while (true) {
        const buffered = reader.buffered();
        if (buffered.len > 0) {
            try body_buf.appendSlice(arena, buffered);
            reader.toss(buffered.len);
        } else {
            const n = reader.readVec(&slices) catch |err| switch (err) {
                error.EndOfStream => break,
                else => return .{ .ok = false, .retryable = common.isRetryableErr(err), .text = try std.fmt.allocPrint(arena, "Exa response read failed: {s}", .{@errorName(err)}) },
            };
            // A 0-return read only means the reader's internal buffer was
            // drained (bytes it had already pulled from the socket); the
            // next iteration re-checks buffered() and the next readVec
            // blocks for more data or returns EndOfStream at true EOF.
            if (n > 0) try body_buf.appendSlice(arena, chunk[0..n]);
        }
        if (body_buf.items.len > MAX_BODY) {
            return .{ .ok = false, .retryable = false, .text = "Exa response too large" };
        }
    }

    const parsed = json.parseFromSliceLeaky(json.Value, arena, body_buf.items, .{}) catch {
        return .{ .ok = false, .retryable = false, .text = "Exa response is not valid JSON" };
    };
    if (parsed != .object) {
        return .{ .ok = false, .retryable = false, .text = "Exa response is not valid JSON" };
    }
    const results = switch (parsed.object.get("results") orelse return .{ .ok = false, .retryable = false, .text = "Exa response is missing results" }) {
        .array => |a| a.items,
        else => return .{ .ok = false, .retryable = false, .text = "Exa response is missing results" },
    };

    var sources: std.ArrayList(Source) = .empty;
    for (results) |rv| {
        if (rv != .object) continue;
        const obj = rv.object;
        const url_raw = mem.trim(u8, if (obj.get("url")) |u| switch (u) {
            .string => |s| s,
            else => "",
        } else "", " \t\r\n");
        if (url_raw.len == 0) continue;
        const title = if (obj.get("title")) |t| switch (t) {
            .string => |s| s,
            else => "",
        } else "";
        const text = if (obj.get("text")) |t| switch (t) {
            .string => |s| s,
            else => "",
        } else "";
        try addSource(arena, &sources, url_raw, title, try normalizeText(arena, text, excerpt_cap));
    }

    var usage: ?[]const u8 = null;
    if (parsed.object.get("costDollars")) |cd| {
        if (cd == .object) {
            if (cd.object.get("total")) |t| {
                const total: f64 = switch (t) {
                    .integer => |i| @floatFromInt(i),
                    .float => |f| f,
                    else => 0,
                };
                if (total > 0) usage = try usageJson(arena, total);
            }
        }
    }

    if (sources.items.len == 0) {
        return .{ .ok = true, .retryable = false, .text = "No results found." };
    }
    const formatted = try formatResult(arena, sources.items);
    if (formatted.len == 0) {
        return .{ .ok = true, .retryable = false, .text = "No results found." };
    }
    return .{ .ok = true, .retryable = false, .text = formatted, .usage = usage };
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

    const res = runExaFetch(arena, ctx.io, url, api_key, body, ctx.excerpt_cap, slot) catch |err| {
        common.workerFinish(slot, false, common.isRetryableErr(err), @errorName(err));
        return;
    };
    common.workerFinishUsage(slot, res.ok, res.retryable, res.text, res.usage);
}

// ---------------------------------------------------------------------------
// search op

fn opSearch(gpa: Allocator, arena: Allocator, io: std.Io, req: Request) !Outcome {
    const query = mem.trim(u8, req.query orelse "", " \t\r\n");
    if (query.len == 0) return failOutcome(arena, "missing query", .{});
    const api_key = mem.trim(u8, req.api_key orelse "", " \t\r\n");
    if (api_key.len == 0) return failOutcome(arena, "missing api_key (EXA_API_KEY)", .{});

    const mode = req.mode orelse "answer";
    const results_mode = mem.eql(u8, mode, "results");
    if (!results_mode and !mem.eql(u8, mode, "answer")) {
        return failOutcome(arena, "mode must be answer or results", .{});
    }

    const num_results = @min(req.num_results orelse 8, MAX_NUM_RESULTS);
    const excerpt_cap: usize = if (results_mode) MAX_SNIPPET else MAX_EXCERPT;
    const endpoint = mem.trim(u8, req.endpoint orelse EXA_URL, " \t\r\n");
    const body = try buildBody(arena, query, num_results, req.recency, req.domains, excerpt_cap);
    const timeout_ms = req.timeout_ms orelse DEFAULT_TIMEOUT_MS;

    var attempt: usize = 0;
    while (true) {
        const ctx = WorkerCtx{ .gpa = gpa, .io = io, .url = endpoint, .api_key = api_key, .body = body, .excerpt_cap = excerpt_cap };
        const res = common.httpWithDeadline(gpa, arena, io, ctx, searchWorker, timeout_ms) catch |err| switch (err) {
            error.TimedOut => return failOutcome(arena, "search timed out after {d}ms", .{timeout_ms}),
            else => return failOutcome(arena, "search request failed: {s}", .{@errorName(err)}),
        };
        if (res.ok) return .{ .ok = true, .text = res.text, .usage = res.usage };
        if (!res.retryable or attempt == 1) return failOutcome(arena, "{s}", .{res.err});
        attempt += 1;
        std.Io.sleep(io, std.Io.Duration.fromMilliseconds(RETRY_BACKOFF_MS), .awake) catch {};
    }
}

// ---------------------------------------------------------------------------
// Self-check: exercises the full pipeline against an in-process HTTP server
// (no network, no external API). The server serves scripted Exa-style JSON
// responses and injects a 500 (retry), a 400 (no retry), an empty result
// set, and a slow response (deadline).

const EXA_HAPPY = "{\"results\":[{\"id\":\"a\",\"title\":\"Alpha Example\",\"url\":\"https://example.com/alpha\",\"publishedDate\":\"2026-08-01T00:00:00.000Z\",\"text\":\"Alpha results here. Alpha results here.\"},{\"id\":\"b\",\"title\":\"Beta Example\",\"url\":\"https://example.com/beta\",\"text\":\"Beta results here.\"},{\"id\":\"a2\",\"title\":\"Alpha Duplicate\",\"url\":\"https://example.com/alpha\",\"text\":\"Duplicate alpha.\"}],\"costDollars\":{\"total\":0.007}}";
const EXA_SINGLE = "{\"results\":[{\"id\":\"a\",\"title\":\"Alpha Example\",\"url\":\"https://example.com/alpha\",\"text\":\"Alpha results here.\"}],\"costDollars\":{\"total\":0.0}}";
const EXA_EMPTY = "{\"results\":[],\"costDollars\":{\"total\":0.0}}";
const EXA_ERROR_500 = "{\"error\":\"self-check injected 500\"}";
const EXA_ERROR_400 = "{\"error\":\"self-check injected 400\"}";

const SELFCHECK_REQUESTS = 8;

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
        if (!mem.eql(u8, req.head.target, "/search")) continue;

        var transfer: [8192]u8 = undefined;
        var body_storage: [64 * 1024]u8 = undefined;
        const br = req.readerExpectNone(&transfer);
        var bw = std.Io.Writer.fixed(&body_storage);
        _ = br.streamRemaining(&bw) catch continue;
        const blen = bw.end;
        @memcpy(ctx.bodies[idx][0..blen], body_storage[0..blen]);
        ctx.body_lens[idx] = blen;

        const json_headers: []const std.http.Header = &.{.{ .name = "content-type", .value = "application/json" }};
        switch (idx) {
            0 => req.respond(EXA_HAPPY, .{ .extra_headers = json_headers }) catch {},
            1 => req.respond(EXA_ERROR_500, .{ .status = .internal_server_error }) catch {},
            2 => req.respond(EXA_HAPPY, .{ .extra_headers = json_headers }) catch {},
            3 => req.respond(EXA_ERROR_400, .{ .status = .bad_request }) catch {},
            4 => req.respond(EXA_SINGLE, .{ .extra_headers = json_headers }) catch {},
            5 => {
                // Deadline test: stall 2s so the 300ms client deadline fires.
                std.Io.sleep(io, std.Io.Duration.fromMilliseconds(2000), .awake) catch {};
                req.respond(EXA_HAPPY, .{ .extra_headers = json_headers }) catch {};
            },
            6 => req.respond(EXA_EMPTY, .{ .extra_headers = json_headers }) catch {},
            else => req.respond(EXA_SINGLE, .{ .extra_headers = json_headers }) catch {},
        }
        ctx.served.store(idx + 1, .release);
    }
}

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
    const endpoint = try std.fmt.allocPrint(arena, "http://127.0.0.1:{d}/search", .{sctx.port.load(.acquire)});

    const mkreq = struct {
        fn f(ep: []const u8, query: []const u8, mode: []const u8, num_results: u32, recency: ?[]const u8, domains: ?[]const []const u8, timeout_ms: u32) Request {
            return .{ .id = 1, .op = "search", .query = query, .mode = mode, .num_results = num_results, .recency = recency, .domains = domains, .endpoint = ep, .api_key = "selfcheck-key", .timeout_ms = timeout_ms };
        }
    }.f;

    // 1. answer mode happy path: numbered sources, dedupe, excerpt, usage
    //    cost, and body assertions for query/numResults/domains/recency.
    const r1 = try opSearch(gpa, arena, io, mkreq(endpoint, "alpha docs", "answer", 5, "week", &.{ "example.com", "-bad.com" }, 10000));
    fail(r1.ok, "answer mode succeeds");
    fail(mem.indexOf(u8, r1.text, "1. Alpha Example (https://example.com/alpha)") != null, "source list has the numbered alpha entry");
    fail(mem.indexOf(u8, r1.text, "2. Beta Example (https://example.com/beta)") != null, "source list has the numbered beta entry");
    fail(mem.indexOf(u8, r1.text, "Alpha results here") != null, "excerpt is included");
    fail(mem.indexOf(u8, r1.text, "3.") == null, "duplicate urls are deduped");
    fail(r1.usage != null and mem.indexOf(u8, r1.usage.?, "\"total\":0.007") != null, "usage carries the Exa cost");
    const b1 = sctx.bodies[0][0..sctx.body_lens[0]];
    fail(mem.indexOf(u8, b1, "\"query\":\"alpha docs\"") != null, "body carries the query");
    fail(mem.indexOf(u8, b1, "\"numResults\":5") != null, "body carries numResults");
    fail(mem.indexOf(u8, b1, "\"includeDomains\":[\"example.com\"]") != null, "allowed domains become includeDomains");
    fail(mem.indexOf(u8, b1, "\"excludeDomains\":[\"bad.com\"]") != null, "blocked domains become excludeDomains");
    fail(mem.indexOf(u8, b1, "\"startPublishedDate\":\"") != null, "recency becomes startPublishedDate");
    fail(mem.indexOf(u8, b1, "\"maxCharacters\":900") != null, "answer mode requests longer excerpts");
    fail(mem.indexOf(u8, b1, "\"useAutoprompt\":false") != null, "the query is not rewritten by autoprompt");

    // 2. retry: the injected 500 is retried once and succeeds.
    const r2 = try opSearch(gpa, arena, io, mkreq(endpoint, "retry me", "answer", 5, null, null, 10000));
    fail(r2.ok, "a 500 is retried and succeeds");
    fail(mem.indexOf(u8, r2.text, "1. Alpha Example") != null, "retried request returns the sources");

    // 3. a 400 surfaces immediately with Exa's message.
    const r3 = try opSearch(gpa, arena, io, mkreq(endpoint, "fail me", "answer", 5, null, null, 10000));
    fail(!r3.ok and mem.indexOf(u8, r3.err, "self-check injected 400") != null, "4xx surfaces the Exa error");

    // 4. results mode: short excerpts and a compact source list.
    const r4 = try opSearch(gpa, arena, io, mkreq(endpoint, "quick look", "results", 3, "day", null, 10000));
    fail(r4.ok, "results mode succeeds");
    const b4 = sctx.bodies[4][0..sctx.body_lens[4]];
    fail(mem.indexOf(u8, b4, "\"maxCharacters\":250") != null, "results mode requests short excerpts");
    fail(mem.indexOf(u8, b4, "\"startPublishedDate\":\"") != null, "recency day becomes startPublishedDate");
    fail(mem.indexOf(u8, b4, "\"numResults\":3") != null, "results mode carries numResults");

    // 5. the deadline fires on a slow endpoint.
    var r5_ok = false;
    var r5_err: []const u8 = "";
    if (opSearch(gpa, arena, io, mkreq(endpoint, "slow", "answer", 5, null, null, 300))) |r| {
        r5_ok = r.ok;
        r5_err = r.err;
    } else |err| {
        r5_ok = false;
        r5_err = @errorName(err);
    }
    fail(!r5_ok and mem.indexOf(u8, r5_err, "timed out") != null, "deadline reported as a timeout");

    // 6. zero results is a clean outcome.
    const r6 = try opSearch(gpa, arena, io, mkreq(endpoint, "nothing", "answer", 5, null, null, 10000));
    fail(r6.ok and mem.eql(u8, r6.text, "No results found."), "empty results return a clean message");

    // 7. no recency: no startPublishedDate in the body.
    const r7 = try opSearch(gpa, arena, io, mkreq(endpoint, "no recency", "answer", 5, null, null, 10000));
    fail(r7.ok, "no-recency search succeeds");
    const b7 = sctx.bodies[7][0..sctx.body_lens[7]];
    fail(mem.indexOf(u8, b7, "startPublishedDate") == null, "no recency means no date filter");

    // 8. validation: missing query / api key / bad mode fail before any HTTP.
    const r8 = try opSearch(gpa, arena, io, .{ .id = 1, .op = "search", .query = "", .api_key = "selfcheck-key", .timeout_ms = 1000 });
    fail(!r8.ok and mem.indexOf(u8, r8.err, "missing query") != null, "missing query fails");
    const r9 = try opSearch(gpa, arena, io, .{ .id = 1, .op = "search", .query = "x", .mode = "bogus", .api_key = "selfcheck-key", .timeout_ms = 1000 });
    fail(!r9.ok and mem.indexOf(u8, r9.err, "mode must be") != null, "bad mode fails");
    const r10 = try opSearch(gpa, arena, io, .{ .id = 1, .op = "search", .query = "x", .api_key = "", .timeout_ms = 1000 });
    fail(!r10.ok and mem.indexOf(u8, r10.err, "missing api_key") != null, "missing api key fails");

    // The server must have served exactly 8 requests (happy, 500, retry,
    // 400, results, timeout, empty, no-recency). Wait for the server to
    // finish (the timeout test's response lands ~2s after the client gave
    // up) before counting.
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
            respondOutcome(arena, io, id, outcome);
        } else {
            respond(arena, io, id, false, "unknown op") catch {};
        }
    }
}
