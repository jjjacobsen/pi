// pi-vision: describe images via a configured vision model.
//
// The pi extension (extensions/vision.ts) registers the describe_image tool
// and calls this binary as a one-shot process: the request travels as one
// JSON argv element via pi.exec, this binary prints one JSON envelope to
// stdout and exits. It loads the image file, detects its format and
// dimensions from the header bytes, compresses it via sips when it exceeds
// the max dimension (JPEG for opaque images, original format for images
// with alpha), base64-encodes it, and POSTs it to the vision model's
// OpenAI-compatible chat/completions endpoint. The model's text response is
// returned as-is.
//
// Request:  {"op":"describe","path":"/abs/img.png","cwd":"/repo","prompt":"...","base_url":"https://...","api_key":"sk-...","model":"mimo-v2.5","headers":[["h","v"],...],"max_dimension":1568,"jpeg_quality":85,"timeout_ms":60000}
// Response: {"ok":true,"result":"...","usage":{...}} | {"ok":false,"error":"..."} (stdout, exit 0/1)
//
// The HTTP call runs on a worker thread so a hung provider cannot stall the
// process: the main thread enforces the deadline and, on expiry, shuts down
// the worker's socket to unblock it and lets the worker finish on its own.
// Retryable failures (429, 5xx, network errors) are retried once after a
// short backoff. Esc aborts the call: pi.exec SIGTERMs the binary, so no
// request can outlive its turn.

const std = @import("std");
const mem = std.mem;
const json = std.json;
const Allocator = std.mem.Allocator;
const common = @import("common.zig");
const List = common.List;
const nowMs = common.nowMs;
const respondExit = common.respondExit;
const respondOutcomeExit = common.respondOutcomeExit;
const runCmd = common.runCmd;

const MAX_SOURCE_BYTES = 64 * 1024 * 1024; // cap on a source image file
const FORCE_COMPRESS_BYTES = 10 * 1024 * 1024; // byte cap before forced resize
const MAX_RESPONSE = 1024 * 1024; // cap on the HTTP response body
const DEFAULT_TIMEOUT_MS = 60000;
const RETRY_BACKOFF_MS = 500;
const MAX_DIMENSION = 1568;
const JPEG_QUALITY = 85;

var tmp_counter: u32 = 0;

const Request = struct {
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

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;

    const argv = init.minimal.args.vector;
    if (argv.len < 2) {
        std.debug.print("usage: pi-vision '<request json>'\n", .{});
        std.process.exit(2);
    }

    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const req = json.parseFromSlice(Request, arena, std.mem.sliceTo(argv[1], 0), .{ .ignore_unknown_fields = true }) catch |err|
        respondExit(arena, io, false, @errorName(err));

    const outcome = if (mem.eql(u8, req.value.op, "describe"))
        opDescribe(gpa, arena, io, req.value) catch |err| respondExit(arena, io, false, @errorName(err))
    else
        respondExit(arena, io, false, "unknown op");

    respondOutcomeExit(arena, io, outcome);
}
