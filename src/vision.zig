// pi-vision: describe images via a configured vision model.
//
// The pi extension (extensions/vision.ts) registers the describe_image tool
// and bridges calls here. This backend loads the image file, detects its
// format and dimensions from the header bytes, compresses it via sips when
// it exceeds the max dimension (JPEG for opaque images, original format for
// images with alpha), base64-encodes it, and POSTs it to the vision model's
// OpenAI-compatible chat/completions endpoint. The model's text response is
// returned as-is.
//
// Request line:  {"id":1,"op":"describe","path":"/abs/img.png","cwd":"/repo","prompt":"...","base_url":"https://...","api_key":"sk-...","model":"mimo-v2.5","headers":[["h","v"],...],"max_dimension":1568,"jpeg_quality":85,"timeout_ms":60000}
// Response line: {"id":1,"ok":true,"result":"..."} | {"id":1,"ok":false,"error":"..."}
//
// The HTTP call runs on a worker thread so a hung provider cannot stall the
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
const nowMs = common.nowMs;
const readLine = common.readLine;
const respond = common.respond;
const runCmd = common.runCmd;

const MAX_LINE = 4 * 1024 * 1024; // hard cap on a single request line
const MAX_SOURCE_BYTES = 64 * 1024 * 1024; // cap on a source image file
const FORCE_COMPRESS_BYTES = 10 * 1024 * 1024; // byte cap before forced resize
const MAX_RESPONSE = 1024 * 1024; // cap on the HTTP response body
const DEFAULT_TIMEOUT_MS = 60000;
const RETRY_BACKOFF_MS = 500;
const MAX_DIMENSION = 1568;
const JPEG_QUALITY = 85;

var tmp_counter: u32 = 0;

const Request = struct {
    id: i64,
    op: []const u8,
    path: ?[]const u8 = null,
    cwd: ?[]const u8 = null,
    prompt: ?[]const u8 = null,
    base_url: ?[]const u8 = null,
    api_key: ?[]const u8 = null,
    headers: ?[]const u8 = null,
    model: ?[]const u8 = null,
    max_dimension: ?u32 = null,
    jpeg_quality: ?u8 = null,
    timeout_ms: ?u32 = null,
};

const Outcome = common.Outcome;
const failOutcome = common.failOutcome;
const respondOutcome = common.respondOutcome;

// ---------------------------------------------------------------------------
// Image detection (header bytes only, no decode)

const ImageInfo = struct {
    mime: []const u8,
    width: u32,
    height: u32,
    has_alpha: bool,
};

fn readBe16(b: []const u8) u16 {
    return (@as(u16, b[0]) << 8) | b[1];
}

fn readBe32(b: []const u8) u32 {
    return (@as(u32, b[0]) << 24) | (@as(u32, b[1]) << 16) | (@as(u32, b[2]) << 8) | b[3];
}

fn readLe16(b: []const u8) u16 {
    return (@as(u16, b[1]) << 8) | b[0];
}

fn readLe24(b: []const u8) u32 {
    return @as(u32, b[0]) | (@as(u32, b[1]) << 8) | (@as(u32, b[2]) << 16);
}

fn readLe32(b: []const u8) u32 {
    return (@as(u32, b[3]) << 24) | (@as(u32, b[2]) << 16) | (@as(u32, b[1]) << 8) | b[0];
}

fn detectPng(bytes: []const u8) !ImageInfo {
    if (bytes.len < 26) return error.UnsupportedFormat;
    if (!mem.eql(u8, bytes[0..8], "\x89PNG\r\n\x1a\n")) return error.UnsupportedFormat;
    if (!mem.eql(u8, bytes[12..16], "IHDR")) return error.UnsupportedFormat;
    const w = readBe32(bytes[16..20]);
    const h = readBe32(bytes[20..24]);
    if (w == 0 or h == 0) return error.UnsupportedFormat;
    const color_type = bytes[25];
    return .{ .mime = "image/png", .width = w, .height = h, .has_alpha = (color_type == 4 or color_type == 6) };
}

fn detectJpeg(bytes: []const u8) !ImageInfo {
    // Walk the marker segments until an SOF marker (C0-CF minus C4/C8/CC),
    // which carries the height and width right after its length field.
    var i: usize = 2;
    while (i + 4 <= bytes.len) {
        if (bytes[i] != 0xff) {
            i += 1;
            continue;
        }
        const marker = bytes[i + 1];
        if (marker == 0xff or marker == 0x00 or marker == 0x01 or (marker >= 0xd0 and marker <= 0xd7)) {
            i += 2; // standalone / fill markers
            continue;
        }
        if (marker == 0xd8 or marker == 0xd9 or marker == 0xda) break;
        const seg_len = readBe16(bytes[i + 2 .. i + 4]);
        if (seg_len < 2 or i + 2 + seg_len > bytes.len) break;
        if (marker >= 0xc0 and marker <= 0xcf and marker != 0xc4 and marker != 0xc8 and marker != 0xcc) {
            if (i + 9 > bytes.len) break;
            const h = readBe16(bytes[i + 5 .. i + 7]);
            const w = readBe16(bytes[i + 7 .. i + 9]);
            if (w == 0 or h == 0) return error.UnsupportedFormat;
            return .{ .mime = "image/jpeg", .width = w, .height = h, .has_alpha = false };
        }
        i += 2 + seg_len;
    }
    return error.UnsupportedFormat;
}

fn detectGif(bytes: []const u8) !ImageInfo {
    if (bytes.len < 10) return error.UnsupportedFormat;
    if (!mem.eql(u8, bytes[0..6], "GIF87a") and !mem.eql(u8, bytes[0..6], "GIF89a")) return error.UnsupportedFormat;
    const w = readLe16(bytes[6..8]);
    const h = readLe16(bytes[8..10]);
    if (w == 0 or h == 0) return error.UnsupportedFormat;
    return .{ .mime = "image/gif", .width = w, .height = h, .has_alpha = true };
}

fn detectWebp(bytes: []const u8) !ImageInfo {
    // Chunks after the RIFF/WEBP header; the first chunk holds the size.
    var i: usize = 12;
    while (i + 8 <= bytes.len) {
        const fourcc = bytes[i .. i + 4];
        const size = readLe32(bytes[i + 4 .. i + 8]);
        if (mem.eql(u8, fourcc, "VP8X")) {
            if (i + 18 > bytes.len) return error.UnsupportedFormat;
            const w = readLe24(bytes[i + 12 ..]) + 1;
            const h = readLe24(bytes[i + 15 ..]) + 1;
            if (w == 0 or h == 0) return error.UnsupportedFormat;
            return .{ .mime = "image/webp", .width = w, .height = h, .has_alpha = (bytes[i + 8] & 0x10) != 0 };
        }
        if (mem.eql(u8, fourcc, "VP8 ")) {
            if (i + 15 > bytes.len) return error.UnsupportedFormat;
            if (bytes[i + 8] != 0x9d or bytes[i + 9] != 0x01 or bytes[i + 10] != 0x2a) return error.UnsupportedFormat;
            const w = readLe16(bytes[i + 11 ..]) & 0x3fff;
            const h = readLe16(bytes[i + 13 ..]) & 0x3fff;
            if (w == 0 or h == 0) return error.UnsupportedFormat;
            return .{ .mime = "image/webp", .width = w, .height = h, .has_alpha = false };
        }
        if (mem.eql(u8, fourcc, "VP8L")) {
            if (i + 13 > bytes.len) return error.UnsupportedFormat;
            if (bytes[i + 8] != 0x2f) return error.UnsupportedFormat;
            const bits = readLe32(bytes[i + 9 ..]);
            const w = (bits & 0x3fff) + 1;
            const h = ((bits >> 14) & 0x3fff) + 1;
            if (w == 0 or h == 0) return error.UnsupportedFormat;
            return .{ .mime = "image/webp", .width = w, .height = h, .has_alpha = ((bits >> 28) & 1) != 0 };
        }
        if (size == 0 or i + 8 + size > bytes.len) break;
        i += 8 + size + (size & 1);
    }
    return error.UnsupportedFormat;
}

fn detectImage(bytes: []const u8) !ImageInfo {
    if (bytes.len >= 8 and mem.eql(u8, bytes[0..8], "\x89PNG\r\n\x1a\n")) return detectPng(bytes);
    if (bytes.len >= 3 and bytes[0] == 0xff and bytes[1] == 0xd8 and bytes[2] == 0xff) return detectJpeg(bytes);
    if (bytes.len >= 6 and (mem.eql(u8, bytes[0..6], "GIF87a") or mem.eql(u8, bytes[0..6], "GIF89a"))) return detectGif(bytes);
    if (bytes.len >= 12 and mem.eql(u8, bytes[0..4], "RIFF") and mem.eql(u8, bytes[8..12], "WEBP")) return detectWebp(bytes);
    return error.UnsupportedFormat;
}

// ---------------------------------------------------------------------------
// Compression via sips (macOS). Opaque images become JPEG (the quality knob
// applies, smallest payload); images with alpha keep their format so
// transparency survives. Small images are never touched.

const CompressedImage = struct {
    bytes: []const u8,
    mime: []const u8,
};

fn compressImage(arena: Allocator, io: std.Io, src: []const u8, info: ImageInfo, max_dim: u32, quality: u8, sips_err: *[]const u8) !CompressedImage {
    const to_jpeg = !info.has_alpha;
    const ext = if (to_jpeg) "jpg" else if (mem.eql(u8, info.mime, "image/gif")) "gif" else "png";
    // The output mime must match what sips actually produced: JPEG for
    // opaque, GIF for GIFs, PNG for anything else with alpha (sips cannot
    // write WebP, so an alpha WebP comes back as PNG).
    // The output format is always explicit: without `-s format` sips defaults
    // to the INPUT format, and its WebP writer is broken ("Can't write
    // format: org.webmproject.webp"), so WebP inputs would fail.
    const fmt = if (to_jpeg) "jpeg" else if (mem.eql(u8, info.mime, "image/gif")) "gif" else "png";
    const out_mime = if (to_jpeg) "image/jpeg" else if (mem.eql(u8, info.mime, "image/gif")) "image/gif" else "image/png";
    const out_path = try std.fmt.allocPrint(arena, "/tmp/pi-vision-{x}-{d}.{s}", .{ @as(u64, @bitCast(nowMs())), tmp_counter, ext });
    tmp_counter += 1;
    defer std.Io.Dir.deleteFileAbsolute(io, out_path) catch {};

    var argv: std.ArrayList([]const u8) = .empty;
    try argv.append(arena, "sips");
    try argv.append(arena, "-Z");
    try argv.append(arena, try std.fmt.allocPrint(arena, "{d}", .{max_dim}));
    try argv.append(arena, "-s");
    try argv.append(arena, "format");
    try argv.append(arena, fmt);
    if (to_jpeg) {
        try argv.append(arena, "-s");
        try argv.append(arena, "formatOptions");
        try argv.append(arena, try std.fmt.allocPrint(arena, "{d}", .{quality}));
    }
    try argv.append(arena, src);
    try argv.append(arena, "--out");
    try argv.append(arena, out_path);

    const res = try runCmd(arena, io, argv.items, 16 * 1024);
    if (!res.ok) {
        sips_err.* = mem.trim(u8, res.stderr, " \t\r\n");
        return error.SipsFailed;
    }
    const bytes = try std.Io.Dir.cwd().readFileAlloc(io, out_path, arena, .limited(MAX_SOURCE_BYTES));
    return .{ .bytes = bytes, .mime = out_mime };
}

// ---------------------------------------------------------------------------
// HTTP call with deadline. The worker owns all allocations (its own arena),
// writes the result into the shared slot buffers, and signals done; the main
// thread waits with a deadline and shuts the worker's socket down on expiry.
// The worker-slot machinery itself (WorkerSlot, workerFinish, retryability,
// httpWithDeadline) lives in common.zig, shared with pi-search.

const WorkerCtx = struct {
    gpa: Allocator,
    io: std.Io,
    url: []const u8,
    api_key: []const u8,
    headers: []const [2][]const u8,
    body: []const u8,
};

const Completion = struct {
    choices: []const Choice = &.{},
    usage: ?CompletionUsage = null,
    @"error": ?CompletionError = null,

    const Choice = struct {
        message: Message = .{},
    };
    // content/reasoning_content are kept as raw json.Value: OpenAI-compatible
    // models return either a plain string ("content":"hi") or a content
    // blocks array ("content":[{"type":"text","text":"hi"},...]), and
    // newer models (e.g. Xiaomi MiMo) always use blocks.
    const Message = struct {
        content: ?json.Value = null,
        reasoning_content: ?json.Value = null,
    };
    const CompletionError = struct {
        message: ?[]const u8 = null,
    };
};

const CompletionUsage = struct {
    prompt_tokens: ?u64 = null,
    completion_tokens: ?u64 = null,
    total_tokens: ?u64 = null,
};

// Serializes the token accounting as a JSON object the glue turns into the
// tool result's usage field (pi's Usage shape; cost is computed by the glue
// from the model's pricing).
fn usageJson(arena: Allocator, u: CompletionUsage) ?[]const u8 {
    const pt = u.prompt_tokens orelse 0;
    const ct = u.completion_tokens orelse 0;
    const tt = u.total_tokens orelse (pt + ct);
    return std.fmt.allocPrint(arena, "{{\"input\":{d},\"output\":{d},\"cacheRead\":0,\"cacheWrite\":0,\"totalTokens\":{d},\"cost\":{{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0,\"total\":0}}}}", .{ pt, ct, tt }) catch null;
}

// Extract the assistant text from a message field, accepting either a plain
// string or a content-blocks array. Text blocks are joined with newlines;
// non-text blocks (image_url etc.) are skipped.
fn textFromValue(arena: Allocator, value: json.Value) !?[]const u8 {
    switch (value) {
        .string => |s| return if (s.len == 0) null else s,
        .array => |items| {
            var parts: std.ArrayList([]const u8) = .empty;
            var total: usize = 0;
            for (items.items) |item| {
                const obj = switch (item) {
                    .object => |o| o,
                    else => continue,
                };
                // Text lives in "text" (content blocks) or "thinking"/"reasoning"
                // (reasoning blocks); take the first non-empty string field.
                const text = blk: {
                    for ([_][]const u8{ "text", "thinking", "reasoning" }) |key| {
                        const v = obj.get(key) orelse continue;
                        if (v == .string and v.string.len > 0) break :blk v.string;
                    }
                    break :blk null;
                } orelse continue;
                try parts.append(arena, text);
                total += text.len + 1;
            }
            if (parts.items.len == 0) return null;
            if (parts.items.len == 1) return parts.items[0];
            const joined = try arena.alloc(u8, total - 1);
            var off: usize = 0;
            for (parts.items, 0..) |p, i| {
                @memcpy(joined[off .. off + p.len], p);
                off += p.len;
                if (i + 1 < parts.items.len) {
                    joined[off] = '\n';
                    off += 1;
                }
            }
            return joined;
        },
        else => return null,
    }
}

// The assistant text: content wins, reasoning_content is the fallback for
// reasoning models that hide the answer there.
fn messageText(arena: Allocator, msg: Completion.Message) !?[]const u8 {
    if (msg.content) |c| {
        const t = try textFromValue(arena, c);
        if (t != null and t.?.len > 0) return t;
    }
    if (msg.reasoning_content) |r| {
        const t = try textFromValue(arena, r);
        if (t != null and t.?.len > 0) return t;
    }
    return null;
}

fn httpWorker(ctx: *WorkerCtx, slot: *common.WorkerSlot) void {
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

    const res = runFetch(arena, ctx.io, url, api_key, headers, body, slot) catch |err| {
        common.workerFinish(slot, false, common.isRetryableErr(err), @errorName(err));
        return;
    };
    const code: u16 = @intFromEnum(res.status);
    if (code >= 200 and code < 300) {
        const parsed = json.parseFromSliceLeaky(Completion, arena, res.body, .{ .ignore_unknown_fields = true }) catch {
            // Surface the raw body (truncated) so unexpected response shapes
            // are diagnosable without packet captures.
            const snippet = res.body[0..@min(res.body.len, 400)];
            common.workerFinish(slot, false, false, std.fmt.allocPrint(arena, "invalid JSON in vision model response: {s}", .{snippet}) catch "invalid JSON in vision model response");
            return;
        };
        if (parsed.choices.len == 0) {
            common.workerFinish(slot, false, false, "vision model returned no content");
            return;
        }
        const msg = parsed.choices[0].message;
        const text = messageText(arena, msg) catch {
            common.workerFinish(slot, false, false, "out of memory");
            return;
        };
        if (text == null or text.?.len == 0) {
            common.workerFinish(slot, false, false, "vision model returned no content");
            return;
        }
        common.workerFinishUsage(slot, true, false, text.?, if (parsed.usage) |u| usageJson(arena, u) else null);
        return;
    }

    const parsed = json.parseFromSliceLeaky(Completion, arena, res.body, .{ .ignore_unknown_fields = true }) catch {
        common.workerFinish(slot, false, common.isRetryableStatus(code), std.fmt.allocPrint(arena, "vision model returned HTTP {d}", .{code}) catch "vision model returned an error");
        return;
    };
    const msg_text = if (parsed.@"error") |e| e.message orelse "" else "";
    if (msg_text.len > 0) {
        common.workerFinish(slot, false, common.isRetryableStatus(code), std.fmt.allocPrint(arena, "vision model returned HTTP {d}: {s}", .{ code, msg_text }) catch "vision model returned an error");
    } else {
        common.workerFinish(slot, false, common.isRetryableStatus(code), std.fmt.allocPrint(arena, "vision model returned HTTP {d}", .{code}) catch "vision model returned an error");
    }
}

const FetchResult = struct {
    status: std.http.Status,
    body: []const u8,
};

fn runFetch(arena: Allocator, io: std.Io, url: []const u8, api_key: []const u8, headers: []const [2][]const u8, body: []const u8, slot: *common.WorkerSlot) !FetchResult {
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
    var buf: [MAX_RESPONSE]u8 = undefined;
    var out = std.Io.Writer.fixed(&buf);
    // The client advertises gzip/deflate in Accept-Encoding, so the body must
    // be decompressed; the raw reader would hand back compressed bytes.
    var transfer_buf: [64]u8 = undefined;
    var decompress_buf: [std.compress.flate.max_window_len]u8 = undefined;
    var decompress: std.http.Decompress = undefined;
    const reader = resp.readerDecompressing(&transfer_buf, &decompress, &decompress_buf);
    _ = reader.streamRemaining(&out) catch |err| switch (err) {
        error.WriteFailed => return error.ResponseTooLarge,
        else => return err,
    };
    return .{ .status = resp.head.status, .body = buf[0..out.end] };
}

// ---------------------------------------------------------------------------
// describe op

fn opDescribe(gpa: Allocator, arena: Allocator, io: std.Io, req: Request) !Outcome {
    const base = mem.trim(u8, req.base_url orelse "", "/");
    if (base.len == 0) return failOutcome(arena, "missing base_url", .{});
    const model = mem.trim(u8, req.model orelse "", " \t\r\n");
    if (model.len == 0) return failOutcome(arena, "missing model", .{});
    const prompt = mem.trim(u8, req.prompt orelse "", " \t\r\n");
    if (prompt.len == 0) return failOutcome(arena, "missing prompt", .{});
    const raw_path = mem.trim(u8, req.path orelse "", " \t\r\n");
    if (raw_path.len == 0) return failOutcome(arena, "missing image path", .{});
    const path = std.fs.path.resolve(arena, &.{ req.cwd orelse "", raw_path }) catch return failOutcome(arena, "invalid image path", .{});

    const bytes = std.Io.Dir.cwd().readFileAlloc(io, path, arena, .limited(MAX_SOURCE_BYTES)) catch |err| switch (err) {
        error.FileNotFound => return failOutcome(arena, "image not found: {s}", .{path}),
        error.StreamTooLong => return failOutcome(arena, "image exceeds the 64MB cap", .{}),
        else => return failOutcome(arena, "cannot read image: {s}", .{@errorName(err)}),
    };
    const info = detectImage(bytes) catch return failOutcome(arena, "unsupported image format; supported: png, jpeg, gif, webp", .{});

    const max_dim = req.max_dimension orelse MAX_DIMENSION;
    const quality = req.jpeg_quality orelse JPEG_QUALITY;

    var payload: []const u8 = bytes;
    var mime = info.mime;
    if (info.width > max_dim or info.height > max_dim or bytes.len > FORCE_COMPRESS_BYTES) {
        var sips_err: []const u8 = "unknown sips error";
        const c = compressImage(arena, io, path, info, max_dim, quality, &sips_err) catch |err| {
            if (err == error.SipsFailed) return failOutcome(arena, "image compression failed: {s}", .{sips_err});
            return failOutcome(arena, "image compression failed: {s}", .{@errorName(err)});
        };
        payload = c.bytes;
        mime = c.mime;
    }

    const b64_len = std.base64.standard.Encoder.calcSize(payload.len);
    const b64 = try arena.alloc(u8, b64_len);
    _ = std.base64.standard.Encoder.encode(b64, payload);

    var body = List.init(arena);
    try body.appendSlice("{\"model\":\"");
    try common.appendJsonEscaped(&body, model);
    try body.appendSlice("\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"image_url\",\"image_url\":{\"url\":\"data:");
    try body.appendSlice(mime);
    try body.appendSlice(";base64,");
    try body.appendSlice(b64);
    try body.appendSlice("\"}},{\"type\":\"text\",\"text\":\"");
    try common.appendJsonEscaped(&body, prompt);
    try body.appendSlice("\"}]}],\"max_tokens\":4096,\"temperature\":0}");

    const hdrs = common.parseHeaders(arena, req.headers) catch return failOutcome(arena, "invalid headers json", .{});
    const url = try std.fmt.allocPrint(arena, "{s}/chat/completions", .{base});
    const timeout_ms = req.timeout_ms orelse DEFAULT_TIMEOUT_MS;
    const api_key = req.api_key orelse "";

    var attempt: usize = 0;
    while (true) {
        const ctx = WorkerCtx{ .gpa = gpa, .io = io, .url = url, .api_key = api_key, .headers = hdrs, .body = body.items };
        const res = common.httpWithDeadline(gpa, arena, io, ctx, httpWorker, timeout_ms) catch |err| switch (err) {
            error.TimedOut => return failOutcome(arena, "vision request timed out after {d}ms", .{timeout_ms}),
            else => return failOutcome(arena, "vision request failed: {s}", .{@errorName(err)}),
        };
        if (res.ok) return .{ .ok = true, .text = res.text, .usage = res.usage };
        if (!res.retryable or attempt == 1) return failOutcome(arena, "{s}", .{res.err});
        attempt += 1;
        std.Io.sleep(io, std.Io.Duration.fromMilliseconds(RETRY_BACKOFF_MS), .awake) catch {};
    }
}

// ---------------------------------------------------------------------------
// Self-check: exercises the full pipeline against an in-process HTTP server
// (no network, no external API). The server injects a 500 to prove the retry
// and a delayed response to prove the deadline.

const TEST_PNG = [_]u8{
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x04, 0x08, 0x02, 0x00, 0x00, 0x00, 0x26, 0x93, 0x09,
    0x29, 0x00, 0x00, 0x00, 0x10, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x47, 0x0c, 0xc4, 0x71, 0x00, 0xae, 0x93, 0x0f, 0xf1, 0xd0, 0x5f, 0x23, 0x9e, 0x00, 0x00, 0x00,
    0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
};

const SELFCHECK_REQUESTS = 7;

const TEST_WEBP = [_]u8{
    0x52, 0x49, 0x46, 0x46, 0x5c, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00,
    0x03, 0x00, 0x00, 0x03, 0x00, 0x00, 0x41, 0x4c, 0x50, 0x48, 0x11, 0x00,
    0x00, 0x00, 0x00, 0x0e, 0x71, 0x2b, 0x00, 0x1f, 0xff, 0xdd, 0x11, 0x1f,
    0xfc, 0xff, 0x20, 0x0a, 0x50, 0x50, 0x0a, 0x00, 0x56, 0x50, 0x38, 0x20,
    0x24, 0x00, 0x00, 0x00, 0x90, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0x04, 0x00,
    0x04, 0x00, 0x01, 0x00, 0x1c, 0x25, 0xa4, 0x00, 0x02, 0xe7, 0x45, 0xac,
    0x00, 0x00, 0xfe, 0xff, 0x42, 0x96, 0x8a, 0x85, 0xaa, 0xe5, 0x43, 0x08,
    0xba, 0xd0, 0x00, 0x00,
};

// Real 4x4 WebP with alpha (cwebp output): VP8X chunk (flags 0x10 = alpha,
// canvas 4x4) followed by an alpha-data chunk and a lossy VP8 frame.
// Exercises the VP8X header parser and the alpha-aware compression path.

const TEST_GZIP = [_]u8{
    0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0xff, 0x4d, 0x8e,
    0x41, 0x0e, 0xc2, 0x40, 0x08, 0x45, 0xaf, 0x62, 0x58, 0x57, 0xe3, 0x7a,
    0xae, 0x62, 0x8c, 0x99, 0x52, 0xda, 0x41, 0xa7, 0xc3, 0xa4, 0x60, 0xac,
    0x69, 0x7a, 0x77, 0x19, 0xdd, 0xb8, 0x02, 0xf2, 0xfe, 0x0b, 0x7f, 0x03,
    0x1e, 0x20, 0x80, 0x22, 0x74, 0x20, 0xfd, 0x9d, 0xd0, 0xfc, 0xc2, 0x14,
    0xed, 0x84, 0x32, 0xd7, 0x4c, 0xc6, 0x52, 0x1c, 0xe1, 0x42, 0xd1, 0xc8,
    0x93, 0xe7, 0x0e, 0x66, 0x19, 0x28, 0x37, 0x87, 0xf2, 0x78, 0xc4, 0x44,
    0xf8, 0x68, 0x81, 0x24, 0x8c, 0xa4, 0x10, 0x2e, 0x1b, 0x70, 0x19, 0x68,
    0xfd, 0x45, 0x49, 0x35, 0x4e, 0x04, 0x61, 0x83, 0x45, 0xb2, 0x4f, 0x88,
    0xaa, 0xac, 0x16, 0x8b, 0x35, 0x47, 0x8a, 0x91, 0x6f, 0xcd, 0xb1, 0x77,
    0x6d, 0xd8, 0x68, 0x6d, 0xe4, 0x3b, 0xfe, 0x3f, 0x84, 0xc3, 0x8b, 0xfa,
    0x7a, 0xa8, 0xae, 0x5b, 0x5a, 0xe4, 0x39, 0x25, 0xd8, 0xaf, 0x7b, 0x07,
    0x23, 0x17, 0xd6, 0x74, 0xf3, 0x76, 0xea, 0x3d, 0xdd, 0x30, 0xa9, 0x8d,
    0x7c, 0x00, 0x3b, 0xe1, 0x0a, 0x3d, 0xd7, 0x00, 0x00, 0x00,
};

// gzip (mtime 0) of the completionBodyBlocks body for "self-check: webp
// passthrough". The server serves it with Content-Encoding: gzip to prove
// the client decompresses (openrouter gzips by default).

const SelfCheckCtx = struct {
    gpa: Allocator,
    io: std.Io,
    port: std.atomic.Value(u16) = std.atomic.Value(u16).init(0),
    bodies: [SELFCHECK_REQUESTS][64 * 1024]u8 = undefined,
    body_lens: [SELFCHECK_REQUESTS]usize = [_]usize{0} ** SELFCHECK_REQUESTS,
    served: std.atomic.Value(usize) = std.atomic.Value(usize).init(0),
};

fn completionBody(arena: Allocator, text: []const u8) ![]const u8 {
    return std.fmt.allocPrint(arena, "{{\"id\":\"sc\",\"object\":\"chat.completion\",\"created\":0,\"model\":\"self-check\",\"choices\":[{{\"index\":0,\"message\":{{\"role\":\"assistant\",\"content\":\"{s}\"}},\"finish_reason\":\"stop\"}}]}}", .{text});
}

// Content-blocks variant: some models (e.g. Xiaomi MiMo) always return
// "content" as an array of blocks instead of a plain string.
fn completionBodyBlocks(arena: Allocator, text: []const u8) ![]const u8 {
    return std.fmt.allocPrint(arena, "{{\"id\":\"sc\",\"object\":\"chat.completion\",\"created\":0,\"model\":\"self-check\",\"choices\":[{{\"index\":0,\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"{s}\"}}]}},\"finish_reason\":\"stop\"}}]}}", .{text});
}

// Reasoning-blocks variant: reasoning models hide the answer in
// "reasoning_content" as an array of thinking blocks with "content": null.
fn completionBodyReasoning(arena: Allocator, text: []const u8) ![]const u8 {
    return std.fmt.allocPrint(arena, "{{\"id\":\"sc\",\"object\":\"chat.completion\",\"created\":0,\"model\":\"self-check\",\"choices\":[{{\"index\":0,\"message\":{{\"role\":\"assistant\",\"content\":null,\"reasoning_content\":[{{\"type\":\"thinking\",\"thinking\":\"{s}\"}}]}},\"finish_reason\":\"stop\"}}]}}", .{text});
}

fn serveThread(ctx: *SelfCheckCtx) void {
    const io = ctx.io;
    var arena_state = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
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
        var wbuf: [4096]u8 = undefined;
        var sr = stream.reader(io, &rbuf);
        var sw = stream.writer(io, &wbuf);
        var hs = std.http.Server.init(&sr.interface, &sw.interface);
        var req = hs.receiveHead() catch continue;
        if (!mem.eql(u8, req.head.target, "/v1/chat/completions")) continue;

        var transfer: [8192]u8 = undefined;
        var body_storage: [64 * 1024]u8 = undefined;
        const br = req.readerExpectNone(&transfer);
        var bw = std.Io.Writer.fixed(&body_storage);
        _ = br.streamRemaining(&bw) catch continue;
        const blen = bw.end;
        @memcpy(ctx.bodies[idx][0..blen], body_storage[0..blen]);
        ctx.body_lens[idx] = blen;

        switch (idx) {
            0 => req.respond("{\"error\":{\"message\":\"self-check injected 500\",\"type\":\"server_error\"}}", .{ .status = .internal_server_error }) catch {},
            1 => req.respond(completionBody(arena, "self-check: 4x4 red png") catch "error", .{}) catch {},
            2 => req.respond(completionBody(arena, "self-check: compressed jpeg") catch "error", .{}) catch {},
            3 => {
                req.respond(&TEST_GZIP, .{ .status = .ok, .extra_headers = &.{.{ .name = "content-encoding", .value = "gzip" }} }) catch {};
            },
            4 => req.respond(completionBodyReasoning(arena, "self-check: webp compressed") catch "error", .{}) catch {},
            5 => req.respond("{\"error\":{\"message\":\"self-check injected 400\",\"type\":\"invalid_request_error\"}}", .{ .status = .bad_request }) catch {},
            else => {
                std.Io.sleep(io, std.Io.Duration.fromMilliseconds(2000), .awake) catch {};
                req.respond(completionBody(arena, "self-check: too late") catch "error", .{}) catch {};
            },
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
    const base_url = try std.fmt.allocPrint(arena, "http://127.0.0.1:{d}/v1", .{sctx.port.load(.acquire)});

    const png_path = "/tmp/pi-vision-selfcheck.png";
    {
        const file = try std.Io.Dir.createFileAbsolute(io, png_path, .{});
        defer file.close(io);
        try common.writeAllIo(io, file, &TEST_PNG);
    }
    defer std.Io.Dir.deleteFileAbsolute(io, png_path) catch {};

    const webp_path = "/tmp/pi-vision-selfcheck.webp";
    {
        const file = try std.Io.Dir.createFileAbsolute(io, webp_path, .{});
        defer file.close(io);
        try common.writeAllIo(io, file, &TEST_WEBP);
    }
    defer std.Io.Dir.deleteFileAbsolute(io, webp_path) catch {};

    const mkreq = struct {
        fn f(base: []const u8, path: []const u8, prompt: []const u8, max_dim: ?u32, timeout_ms: ?u32) Request {
            return .{ .id = 1, .op = "describe", .path = path, .cwd = "/tmp", .prompt = prompt, .base_url = base, .api_key = "selfcheck-key", .model = "self-check", .max_dimension = max_dim, .timeout_ms = timeout_ms };
        }
    }.f;

    // 1. passthrough + retry: small PNG goes through untouched (data URL is
    //    image/png), the server's injected 500 triggers the single retry.
    const r1 = try opDescribe(gpa, arena, io, mkreq(base_url, png_path, "what color is this", 1000, 10000));
    fail(r1.ok, "describe succeeds on a small png");
    fail(mem.eql(u8, r1.text, "self-check: 4x4 red png"), "description text round-trips");
    fail(mem.indexOf(u8, sctx.bodies[0][0..sctx.body_lens[0]], "data:image/png;base64,") != null, "small png passes through unmodified");
    fail(mem.indexOf(u8, sctx.bodies[1][0..sctx.body_lens[1]], "data:image/png;base64,") != null, "retry resends the same body");

    // 2. sips compression: max dimension 2 forces a resize to JPEG.
    const r2 = opDescribe(gpa, arena, io, mkreq(base_url, png_path, "compress me", 2, 10000)) catch |err| {
        if (err == error.SipsFailed) {
            std.debug.print("NOTE: sips unavailable, compression path skipped\n", .{});
        } else {
            std.debug.print("FAIL: describe with sips compression: {s}\n", .{@errorName(err)});
            std.process.exit(1);
        }
        return;
    };
    if (r2.ok) {
        fail(mem.eql(u8, r2.text, "self-check: compressed jpeg"), "compressed description round-trips");
        fail(mem.indexOf(u8, sctx.bodies[2][0..sctx.body_lens[2]], "data:image/jpeg;base64,") != null, "resized image is sent as jpeg");
    }

    // 2b. WebP passthrough: the 4x4 alpha WebP is small enough to send as-is.
    const r2b = try opDescribe(gpa, arena, io, mkreq(base_url, webp_path, "webp passthrough", 1000, 10000));
    fail(r2b.ok, "describe succeeds on a small webp");
    fail(mem.eql(u8, r2b.text, "self-check: webp passthrough"), "webp description round-trips");
    fail(mem.indexOf(u8, sctx.bodies[3][0..sctx.body_lens[3]], "data:image/webp;base64,") != null, "small webp passes through with its mime");

    // 2c. WebP compression: max dimension 2 forces sips; the alpha flag must
    //     be read correctly (WebP keeps transparency -> PNG output, not JPEG).
    const r2c = opDescribe(gpa, arena, io, mkreq(base_url, webp_path, "compress webp", 2, 10000)) catch |err| {
        if (err == error.SipsFailed) {
            std.debug.print("NOTE: sips unavailable, webp compression path skipped\n", .{});
        } else {
            std.debug.print("FAIL: describe with webp sips compression: {s}\n", .{@errorName(err)});
            std.process.exit(1);
        }
        return;
    };
    fail(r2c.ok, "webp compression succeeds (sips needs an explicit output format)");
    fail(mem.eql(u8, r2c.text, "self-check: webp compressed"), "webp compression description round-trips");
    fail(mem.indexOf(u8, sctx.bodies[4][0..sctx.body_lens[4]], "data:image/png;base64,") != null, "alpha webp compresses to png (transparency kept)");

    // 3. non-retryable 4xx surfaces immediately with the provider's message.
    const r3 = try opDescribe(gpa, arena, io, mkreq(base_url, png_path, "fail me", 1000, 10000));
    fail(!r3.ok and mem.indexOf(u8, r3.err, "self-check injected 400") != null, "4xx surfaces the provider error");

    // 4. deadline: the server sleeps 2s, the client gives up at 300ms.
    const r4 = opDescribe(gpa, arena, io, mkreq(base_url, png_path, "slow", 1000, 300)) catch |err| {
        fail(err == error.TimedOut, "deadline fires on a slow provider");
        return;
    };
    fail(!r4.ok and mem.indexOf(u8, r4.err, "timed out") != null, "deadline reported as a timeout");

    // 5. missing file and unsupported format.
    const r5 = try opDescribe(gpa, arena, io, mkreq(base_url, "/tmp/pi-vision-no-such-file.png", "x", 1000, 10000));
    fail(!r5.ok and mem.indexOf(u8, r5.err, "not found") != null, "missing file reported");
    const text_path = "/tmp/pi-vision-selfcheck.txt.png";
    {
        const file = try std.Io.Dir.createFileAbsolute(io, text_path, .{});
        defer file.close(io);
        try common.writeAllIo(io, file, "definitely not an image");
    }
    defer std.Io.Dir.deleteFileAbsolute(io, text_path) catch {};
    const r6 = try opDescribe(gpa, arena, io, mkreq(base_url, text_path, "x", 1000, 10000));
    fail(!r6.ok and mem.indexOf(u8, r6.err, "unsupported image format") != null, "non-image rejected");

    // The server must have served exactly 7 requests (2 for the retry test,
    // 1 compression, 1 four-hundred, 1 timeout, 2 webp). A wrongly retried
    // 4xx or a double send would shift the count. Wait for the server to
    // finish serving (the timeout test's response lands ~2s after the client
    // gave up) before counting.
    var waited: i64 = 0;
    while (sctx.served.load(.acquire) != SELFCHECK_REQUESTS) : (waited += 10) {
        if (waited > 5000) break;
        std.Io.sleep(io, std.Io.Duration.fromMilliseconds(10), .awake) catch {};
    }
    fail(sctx.served.load(.acquire) == SELFCHECK_REQUESTS, "server request count is exact");

    std.debug.print("PASS: pi-vision self-check ok\n", .{});
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

        if (mem.eql(u8, req.value.op, "describe")) {
            const outcome = opDescribe(gpa, arena, io, req.value) catch |err| {
                respond(arena, io, id, false, @errorName(err)) catch {};
                continue;
            };
            respondOutcome(arena, io, id, outcome);
        } else {
            respond(arena, io, id, false, "unknown op") catch {};
        }
    }
}
