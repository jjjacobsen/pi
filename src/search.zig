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
// Request:  {"op":"search","query":"...","mode":"answer","num_results":8,"recency":"week","domains":["example.com","-bad.com"],"api_key":"...","timeout_ms":30000} (one JSON argv element)
// Response: {"ok":true,"result":"...","usage":{"...cost..."}} | {"ok":false,"error":"..."} (stdout, exit 0/1)
//
// The HTTP call runs on a worker thread so a hung endpoint cannot stall the
// process: the main thread enforces the deadline and, on expiry, shuts down
// the worker's socket to unblock it and lets the worker finish on its own.
// Retryable failures (429, 5xx, network errors) are retried once after a
// short backoff. Esc aborts the call: pi.exec SIGTERMs the binary, so no
// request can outlive its turn.

const std = @import("std");
const posix = std.posix;
const mem = std.mem;
const json = std.json;
const Allocator = std.mem.Allocator;
const common = @import("common.zig");
const List = common.List;
const respondExit = common.respondExit;
const respondOutcomeExit = common.respondOutcomeExit;
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
    op: []const u8,
    query: ?[]const u8 = null,
    mode: ?[]const u8 = null,
    num_results: ?u32 = null,
    recency: ?[]const u8 = null,
    domains: ?[]const []const u8 = null,
    api_key: ?[]const u8 = null,
    timeout_ms: ?u32 = null,
};

const Outcome = common.Outcome;
const failOutcome = common.failOutcome;

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
    const endpoint = EXA_URL;
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

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;

    const argv = init.minimal.args.vector;
    if (argv.len < 2) {
        std.debug.print("usage: pi-search '<request json>'\n", .{});
        std.process.exit(2);
    }

    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const req = json.parseFromSlice(Request, arena, std.mem.sliceTo(argv[1], 0), .{ .ignore_unknown_fields = true }) catch |err|
        respondExit(arena, io, false, @errorName(err));

    const outcome = if (mem.eql(u8, req.value.op, "search"))
        opSearch(gpa, arena, io, req.value) catch |err| respondExit(arena, io, false, @errorName(err))
    else
        respondExit(arena, io, false, "unknown op");

    respondOutcomeExit(arena, io, outcome);
}
